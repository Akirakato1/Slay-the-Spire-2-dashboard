const { app, BrowserWindow, ipcMain, dialog, utilityProcess, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Must be called before app.ready. Three custom schemes:
//   appdata://      → user-data Assets/ (existing — wiki-scrape era; kept for
//                     legacy compat with bits of the renderer that still hit it)
//   extracted://    → user-data Tools/extraction/raw/ (GDRE-extracted images,
//                     fonts, decompiled-source-relative paths)
//   cardassets://   → repo-bundled "card render assets/" (frames, banners,
//                     mana orbs, the renderer's static bundle)
protocol.registerSchemesAsPrivileged([
  { scheme: 'appdata',    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'extracted',  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'cardassets', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let watcher = null;
const appdataBase   = path.join(app.getPath('userData'), 'Assets');
const settingsDir   = path.join(appdataBase, 'settings');
const configPath    = path.join(settingsDir, 'config.json');
const favoritesPath = path.join(settingsDir, 'favorites.json');

// Ensure required asset directories exist on first run
const dataDir            = path.join(appdataBase, 'data');                 // simplifier output (cards.json, etc.)
const imagesDir          = path.join(appdataBase, 'images');               // image asset root (relics, events, …, plus the rendered card PNGs)
const extractedDir       = path.join(appdataBase, 'data-extracted', 'eng'); // raw spire-codex parser output
const shellsDir          = path.join(appdataBase, 'shells');                // pre-rendered card shell PNGs (Strategy B intermediate)
// Strategy A: rendered card PNGs live FLAT at images/cards/<key>.png.
// During the pipeline, card portraits are temporarily migrated into the
// per-color subfolders images/cards/<color>/<file>.png so the renderer
// process can read them via appdata://. After the bake those subfolders
// are wiped (see wipePostRenderArtifacts), leaving only the flat rendered
// PNGs as the dashboard's runtime card-image source.
const cardsRenderedDir   = path.join(imagesDir, 'cards');
const sharedRunsDir      = path.join(app.getPath('userData'), 'Shared Runs');

// Pipeline scratch dirs — GDRE writes its PCK extraction under raw/, dnSpy
// writes decompiled C# under decompiled/. The `extracted://` protocol serves
// from rawDir.
const toolsRoot      = path.join(app.getPath('userData'), 'Tools');
const extractionDir  = path.join(toolsRoot, 'extraction');
const rawDir         = path.join(extractionDir, 'raw');
const decompiledDir  = path.join(extractionDir, 'decompiled');

// Repo-bundled card-render asset directory served via `cardassets://`.
// Card render assets are bundled with the app. In production, electron-
// builder packs the source into app.asar — but reading binary blobs out
// of asar is fragile (case-sensitive lookup; some Electron APIs can't
// resolve asar paths). The build config opts these out via `asarUnpack`,
// which extracts them next to the asar at app.asar.unpacked/. We resolve
// to the unpacked path in production, and to the source folder in dev.
const CARD_ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'card render assets')
  : path.join(__dirname, '..', 'card render assets');

try { fs.mkdirSync(settingsDir,   { recursive: true }); } catch (_) {}
try { fs.mkdirSync(dataDir,       { recursive: true }); } catch (_) {}
try { fs.mkdirSync(imagesDir,     { recursive: true }); } catch (_) {}
try { fs.mkdirSync(extractedDir,  { recursive: true }); } catch (_) {}
try { fs.mkdirSync(sharedRunsDir, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(toolsRoot,     { recursive: true }); } catch (_) {}

function saveSharedRun(name, contentString) {
  try {
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
    if (!safe) return null;
    const filename = safe.endsWith('.run') ? safe : safe + '.run';
    const fullPath = path.join(sharedRunsDir, filename);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, contentString, 'utf8');
    }
    return fullPath;
  } catch (e) {
    console.warn('Failed to save shared run:', e);
    return null;
  }
}

// ── Config helpers ──────────────────────────────────────────────────────────

function readConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read config:', e);
  }
  return null;
}

function writeConfig(data) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to write config:', e);
    return false;
  }
}

// ── Window factory ──────────────────────────────────────────────────────────

function createWindow(page) {
  if (mainWindow) {
    mainWindow.close();
    mainWindow = null;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // both in src/
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, '..', 'Slay_the_Spire_2_icon.webp')
  });

  mainWindow.loadFile(path.join(__dirname, page));

  // Use a local ref so a late-firing 'closed' event from the *previous* window
  // doesn't null out mainWindow after it already points to the new window.
  const thisWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (mainWindow === thisWindow) mainWindow = null;
  });
}

// ── File watcher ─────────────────────────────────────────────────────────────

function startWatcher(folderPath) {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  try {
    // Try chokidar first; fall back to fs.watch
    let chokidar;
    try {
      chokidar = require('chokidar');
    } catch (_) {
      chokidar = null;
    }

    if (chokidar) {
      watcher = chokidar.watch(folderPath, {
        ignored: (filePath) => {
          const base = path.basename(filePath);
          // ignore hidden files but watch .run files and directories
          return base.startsWith('.') && base !== path.basename(folderPath);
        },
        persistent: true,
        ignoreInitial: true,
        depth: 1
      });

      watcher.on('add', (filePath) => {
        if (filePath.endsWith('.run')) notifyRefresh();
      });
      watcher.on('change', (filePath) => {
        if (filePath.endsWith('.run')) notifyRefresh();
      });
      watcher.on('unlink', (filePath) => {
        if (filePath.endsWith('.run')) notifyRefresh();
      });
    } else {
      // Fallback: native fs.watch
      watcher = fs.watch(folderPath, { persistent: true }, (eventType, filename) => {
        if (filename && filename.endsWith('.run')) {
          notifyRefresh();
        }
      });
    }
  } catch (e) {
    console.error('Watcher error:', e);
  }
}

function notifyRefresh() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runs-changed');
  }
}

// ── Favorites helpers ────────────────────────────────────────────────────────

function readFavorites() {
  try {
    if (fs.existsSync(favoritesPath)) return JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
  } catch (e) { console.error('Failed to read favorites:', e); }
  return [];
}

function writeFavorites(arr) {
  try { fs.writeFileSync(favoritesPath, JSON.stringify(arr), 'utf8'); return true; }
  catch (e) { console.error('Failed to write favorites:', e); return false; }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => {
  return readConfig();
});

ipcMain.handle('get-assets-path', () => appdataBase);

ipcMain.handle('save-config', (_event, data) => {
  const ok = writeConfig(data);
  if (ok && data.historyFolder) {
    startWatcher(data.historyFolder);
  }
  return ok;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select STS2 History Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-run-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Run File',
    filters: [{ name: 'Run Files', extensions: ['run'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const sourcePath = result.filePaths[0];
    const raw    = fs.readFileSync(sourcePath, 'utf8');
    const parsed = JSON.parse(raw);
    const sharedPath = saveSharedRun(path.basename(sourcePath), raw);
    parsed._filePath = sharedPath || sourcePath;
    return parsed;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('read-shared-runs', () => {
  try {
    if (!fs.existsSync(sharedRunsDir)) return { error: null, files: [] };
    const entries = fs.readdirSync(sharedRunsDir).filter(f => f.endsWith('.run'));
    const runs = [];
    for (const file of entries) {
      const filePath = path.join(sharedRunsDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        parsed._filePath = filePath;
        runs.push(parsed);
      } catch (e) {
        console.warn(`Failed to parse shared run ${file}:`, e.message);
      }
    }
    return { error: null, files: runs };
  } catch (e) {
    return { error: e.message, files: [] };
  }
});

ipcMain.handle('read-run-files', (_event, folderPath) => {
  try {
    if (!fs.existsSync(folderPath)) return { error: 'Folder not found', files: [] };

    const entries = fs.readdirSync(folderPath);
    const runFiles = entries.filter((f) => f.endsWith('.run'));
    const runs = [];

    for (const file of runFiles) {
      const filePath = path.join(folderPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        parsed._filePath = filePath;
        runs.push(parsed);
      } catch (e) {
        console.warn(`Failed to parse ${file}:`, e.message);
      }
    }

    return { error: null, files: runs };
  } catch (e) {
    return { error: e.message, files: [] };
  }
});

ipcMain.handle('copy-file', (_event, filePath) => {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) { resolve(false); return; }
    // Use PowerShell Set-Clipboard -Path to copy the file itself to clipboard
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Set-Clipboard -Path ${JSON.stringify(filePath)}`
    ]);
    ps.on('close', (code) => resolve(code === 0));
    ps.on('error', () => resolve(false));
  });
});

ipcMain.handle('export-to-pastebin', async (_event, { filePath, apiKey }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: 'Run file not found.' };
    const raw = fs.readFileSync(filePath, 'utf8');
    const body = new URLSearchParams({
      api_dev_key:         apiKey,
      api_option:          'paste',
      api_paste_code:      raw,
      api_paste_name:      path.basename(filePath),
      api_paste_format:    'json',
      api_paste_private:   '0',
      api_paste_expire_date: 'N',
    });
    const resp = await fetch('https://pastebin.com/api/api_post.php', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(15000),
    });
    const text = (await resp.text()).trim();
    if (!text.startsWith('https://')) return { error: text };
    // Copy URL to clipboard
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Set-Clipboard -Value ${JSON.stringify(text)}`
    ]);
    await new Promise((r) => { ps.on('close', r); ps.on('error', r); });
    return { url: text };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fetch-pastebin', async (_event, url) => {
  try {
    let rawUrl = (url || '').trim();
    // Extract pastebin id, accepting either https://pastebin.com/XXXX or the /raw/ variant
    const idMatch = rawUrl.match(/pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)/);
    const pasteId = idMatch ? idMatch[1] : null;
    if (pasteId) rawUrl = `https://pastebin.com/raw/${pasteId}`;
    const resp = await fetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}: could not fetch URL.` };
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return { error: 'Content is not valid JSON.' }; }
    // Basic validation: must look like a run file
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.players)) {
      return { error: 'Not a valid .run file — missing expected fields.' };
    }
    if (pasteId) {
      const sharedPath = saveSharedRun(pasteId, text);
      if (sharedPath) parsed._filePath = sharedPath;
    }
    return { data: parsed };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-favorites', () => readFavorites());

ipcMain.handle('toggle-favorite', (_event, key) => {
  const favs = new Set(readFavorites());
  if (favs.has(key)) favs.delete(key);
  else favs.add(key);
  const arr = [...favs];
  writeFavorites(arr);
  return arr;
});

ipcMain.handle('navigate-to-dashboard', () => {
  createWindow('index.html');
  const cfg = readConfig();
  if (cfg && cfg.historyFolder) startWatcher(cfg.historyFolder);
});

ipcMain.handle('navigate-to-setup', () => {
  createWindow('setup.html');
});

// ── Local extraction tools (Phase 2) ────────────────────────────────────────

const { detect: detectSteam } = require('./tools/steam_detect.js');
const toolManager             = require('./tools/tool_manager.js');

// Parsers + simplifier — the pipeline producers. Same modules the
// mock-test-app uses end-to-end; references them by absolute path so they
// resolve regardless of cwd.
const PARSERS_DIR     = path.join(__dirname, '..', 'scripts', 'parsers');
const cardParser      = require(path.join(PARSERS_DIR, 'card_parser.js'));
const relicParser     = require(path.join(PARSERS_DIR, 'relic_parser.js'));
const potionParser    = require(path.join(PARSERS_DIR, 'potion_parser.js'));
const enchParser      = require(path.join(PARSERS_DIR, 'enchantment_parser.js'));
const eventParser     = require(path.join(PARSERS_DIR, 'event_parser.js'));
const { simplifyAll } = require(path.join(__dirname, '..', 'scripts', 'simplifier.js'));

// Map generation lives under scripts/mapgen and runs in the main process so
// the renderer (with nodeIntegration:false) can request SVGs over IPC.
const { generateActMap: _genActMap } = require(path.join(__dirname, '..', 'scripts', 'mapgen', 'index.js'));
const { renderSvg: _renderActSvg }   = require(path.join(__dirname, '..', 'scripts', 'mapgen', 'render_svg.js'));
const { extractMapAssets: _extractMapAssets, processStagedMapAssets, _testSliceSpineBoss } = require(path.join(__dirname, '..', 'scripts', 'extract_map_assets.js'));

// Convenience paths under appdata for map assets. Render reads from these;
// extraction writes to these. Subdirs (`map_icons`, `map_backdrops`) are
// created on demand by the extractor.
const mapAssetsDir = path.join(imagesDir);   // Assets/images/{map_icons, map_backdrops}/

// Trigger a fresh extraction of all map-related image assets from the user's
// PCK install. Streams progress via 'map-assets-extract-progress'.
// Debug: re-slice a single Spine boss atlas to a custom output path. Lets us
// iterate on SPINE_BOSS_OVERRIDES without re-running the full pipeline.
//   await electronAPI.sliceSpineBossTest(atlasPath, outputPath)
ipcMain.handle('slice-spine-boss-test', (_event, atlasPath, outputPath) => {
  try {
    if (!atlasPath || !outputPath) return { ok: false, error: 'atlasPath and outputPath required' };
    if (!fs.existsSync(atlasPath))   return { ok: false, error: `atlas not found: ${atlasPath}` };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    _testSliceSpineBoss(atlasPath, outputPath);
    return { ok: true, outputPath };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
});

ipcMain.handle('extract-map-assets', async () => {
  try {
    const steam = detectSteam();
    if (!steam.found || !steam.install.pckExists) return { ok: false, error: 'STS2 install / PCK not found' };
    const gdre = toolManager.detectInstalled('gdre');
    if (!gdre.installed) return { ok: false, error: 'GDRE Tools not installed (run the resource-update flow first)' };

    const result = await _extractMapAssets({
      pckPath:   steam.install.pckPath,
      gdreExe:   gdre.executablePath,
      outputDir: mapAssetsDir,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('map-assets-extract-progress', p);
        }
      },
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
});

// Generate the SVG for one act of a run, with click hooks for each node on
// the user's recorded path. Returns:
//   { ok, svg, pathNodeMap, alignment }
// where pathNodeMap[k] = { col, row, nodeInAct } for path[k]; the renderer
// uses this to map (col,row) clicks back to the corresponding stepper step.
ipcMain.handle('generate-act-map', (_event, runData, actIndex) => {
  try {
    const acts = runData.acts || [];
    if (actIndex < 0 || actIndex >= acts.length) {
      return { ok: false, error: `actIndex ${actIndex} out of range (0..${acts.length - 1})` };
    }
    const actId        = acts[actIndex];
    const histories    = runData.map_point_history || [];
    const visited      = histories[actIndex] || null;
    const isMultiplayer = (runData.players?.length || 1) > 1
                       || (runData.game_mode && /(co_op|coop|multi)/i.test(String(runData.game_mode)));

    // The "death act" is the final act with any visited nodes when the run
    // didn't end in victory (defeat or abandon). For it, allow alignPath to
    // accept a partial path (not ending in boss) and mark the player's last
    // node with a red X overlay in the SVG.
    let lastActWithVisits = -1;
    for (let i = histories.length - 1; i >= 0; i--) {
      if (Array.isArray(histories[i]) && histories[i].length > 0) {
        lastActWithVisits = i;
        break;
      }
    }
    const isDeathAct = !runData.win && actIndex === lastActWithVisits;

    const { graph, alignment } = _genActMap({
      actId, actIndex,
      seedString:    runData.seed,
      ascension:     runData.ascension,
      modifiers:     runData.modifiers,
      isMultiplayer,
      visited,
      allowPartialPath: isDeathAct,
    });

    // Pick the boss model_id(s) and ancient model_id from visit history so the
    // renderer can use the right icons.
    const bossModelIds = [];
    let ancientModelId = null;
    for (const entry of (visited || [])) {
      if (entry?.map_point_type === 'boss' && entry.rooms?.[0]?.model_id) {
        bossModelIds.push(entry.rooms[0].model_id);
      } else if (entry?.map_point_type === 'ancient' && entry.rooms?.[0]?.model_id && !ancientModelId) {
        ancientModelId = entry.rooms[0].model_id;
      }
    }

    // Build the click-to-step mapping. Path index k corresponds to visited[k]
    // in the run's per-act history; the renderer combines our nodeInAct with
    // its stepper data to produce the absolute step index.
    const pathNodeMap = [];
    if (alignment.ok) {
      alignment.path.forEach((p, k) => {
        pathNodeMap.push({ col: p.coord.col, row: p.coord.row, nodeInAct: k });
      });
    }

    const svg = _renderActSvg(graph, alignment.ok ? alignment.path : [], {
      actId, bossModelIds, ancientModelId,
      clickableSteps: pathNodeMap,
      iconsDir:     path.join(mapAssetsDir, 'map_icons'),
      backdropsDir: path.join(mapAssetsDir, 'map_backdrops'),
      markLastPathNodeAsDeath: isDeathAct && alignment.ok && (alignment.path?.length || 0) > 0,
    });

    return {
      ok: true, svg, pathNodeMap, actId,
      alignment: { ok: alignment.ok, ambiguous: !!alignment.ambiguous, reason: alignment.reason || null },
    };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
});

// Find the user's STS2 install. Optionally takes a custom Steam folder path
// for the BYO-path flow when auto-detect fails.
ipcMain.handle('detect-sts2-install', (_event, customSteamPath = null) => {
  try { return detectSteam(customSteamPath); }
  catch (e) { return { found: false, errors: [e.message] }; }
});

ipcMain.handle('tools-detect-all', () => toolManager.detectAll());

ipcMain.handle('tools-fetch-release', async (_event, name) => {
  try { return { ok: true, release: await toolManager.fetchLatestRelease(name) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Install a tool (download + extract). Streams progress via 'tools-install-progress'.
ipcMain.handle('tools-install', async (_event, name) => {
  try {
    const result = await toolManager.installTool(name, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tools-install-progress', { tool: name, ...progress });
      }
    });
    return { ok: true, detected: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Kernel data (bundled with app) ──────────────────────────────────────────
// Kernels live alongside the app source so they ship in the packaged build.
// One JSON per consecutive version transition, plus a manifest. Renderer
// composes them at run-render time to reconstruct period-accurate stats for
// saves on older builds. Phase 3 will add a runtime sync from GitHub raw.

// All kernel data is fetched from the GitHub repo at runtime — nothing
// bundled. The fetch lands in writable user appdata so subsequent launches
// can render saves offline against the last-fetched copy.
const remoteKernelDir = path.join(appdataBase, 'kernels-remote');
const remoteManifest  = path.join(appdataBase, 'manifest.json');
try { fs.mkdirSync(remoteKernelDir, { recursive: true }); } catch (_) {}

// GitHub repo coordinates for kernel + manifest auto-sync. Both sit under
// kernel-editor/ in the dashboard repo (Release Version/kernel-editor/);
// the public-facing GitHub paths include the `Release Version/` prefix.
const KERNELS_REPO_OWNER  = 'Akirakato1';
const KERNELS_REPO_NAME   = 'Slay-the-Spire-2-dashboard';
const KERNELS_REPO_BRANCH = 'main';
// The repo layout on GitHub is flat: kernel-editor/, card render assets/,
// src/, scripts/ etc. all live at the repo root (no Release Version/
// wrapper, even though local working dirs may have one).
const KERNEL_EDITOR_PATH  = 'kernel-editor';
const KERNELS_RAW_BASE    =
  `https://raw.githubusercontent.com/${KERNELS_REPO_OWNER}/${KERNELS_REPO_NAME}/${KERNELS_REPO_BRANCH}/${KERNEL_EDITOR_PATH}/kernels`;
const MANIFEST_RAW_URL    =
  `https://raw.githubusercontent.com/${KERNELS_REPO_OWNER}/${KERNELS_REPO_NAME}/${KERNELS_REPO_BRANCH}/${KERNEL_EDITOR_PATH}/manifest.json`;

ipcMain.handle('get-kernels-bundle', () => {
  try {
    // Manifest comes from the GitHub-synced cache (written during the
    // pipeline's [sync] stage). No bundled fallback — first-run pipeline
    // is expected to have internet (we already download GDRE + dnSpy).
    const manifest = fs.existsSync(remoteManifest)
      ? JSON.parse(fs.readFileSync(remoteManifest, 'utf8'))
      : null;

    // Finalized kernels live in remoteKernelDir (synced from GitHub).
    const kernels = {};
    if (fs.existsSync(remoteKernelDir)) {
      for (const f of fs.readdirSync(remoteKernelDir)) {
        if (!f.endsWith('.json')) continue;
        try { kernels[`kernels/${f}`] = JSON.parse(fs.readFileSync(path.join(remoteKernelDir, f), 'utf8')); }
        catch (e) { console.warn(`Failed to parse kernel ${f}:`, e.message); }
      }
    }
    return { manifest, kernels };
  } catch (e) {
    console.warn('get-kernels-bundle failed:', e);
    return { manifest: null, kernels: {} };
  }
});

// ── Remote kernel sync ──────────────────────────────────────────────────────
// Fires on launch, best-effort. Compares the bundled manifest's
// current_version against the GitHub copy; if remote is ahead (or has new
// kernel files), downloads them into remoteKernelDir. Silent on failure —
// the user always has at least the bundled set to fall back on.

async function _fetchJson(url, timeoutMs = 10000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (sts2-dashboard kernel sync)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function _fetchText(url, timeoutMs = 10000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (sts2-dashboard kernel sync)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function syncKernelsFromRemote() {
  try {
    // The repo lists kernels via the GitHub Contents API (no manifest needed).
    // Each entry's `download_url` points straight at the raw .json blob.
    const apiUrl = `https://api.github.com/repos/${KERNELS_REPO_OWNER}/${KERNELS_REPO_NAME}`
                 + `/contents/${KERNEL_EDITOR_PATH}/kernels?ref=${KERNELS_REPO_BRANCH}`;
    const listing = await _fetchJson(apiUrl);
    if (!Array.isArray(listing)) return { ok: false, error: 'unexpected GitHub Contents response' };

    // Fetch the manifest separately. The dashboard reads it at runtime as
    // its chronological version index for disk-PNG resolution; without
    // this, get-kernels-bundle returns null and versioned PNGs can't
    // resolve. Best-effort — if it fails the rest of the sync still runs.
    let manifestFetched = false;
    try {
      const body = await _fetchText(MANIFEST_RAW_URL);
      const parsed = JSON.parse(body);
      fs.writeFileSync(remoteManifest, JSON.stringify(parsed, null, 2), 'utf8');
      manifestFetched = true;
    } catch (e) {
      console.warn('manifest sync: failed —', e.message);
    }

    let downloaded = 0, skipped = 0, failed = 0;
    for (const entry of listing) {
      if (!entry || entry.type !== 'file') continue;
      const filename = entry.name;
      if (!filename || !filename.endsWith('.json')) continue;
      // Skip only when our remote cache already has the file with the same
      // SHA — GitHub returns its blob SHA in the listing, and we stamp each
      // downloaded file with `_remoteSha` so re-runs are cheap. The bundled
      // dir is intentionally NOT consulted here: bundled is the offline
      // baseline shipped with the app, remote always wins (and we want the
      // user to see Assets/kernels-remote/ populate after first sync).
      const localRemote = path.join(remoteKernelDir, filename);
      if (fs.existsSync(localRemote)) {
        try {
          const cached = JSON.parse(fs.readFileSync(localRemote, 'utf8'));
          if (cached && cached._remoteSha && cached._remoteSha === entry.sha) {
            skipped++; continue;
          }
        } catch (_) { /* corrupt cache → re-download */ }
      }
      try {
        const body = await _fetchText(entry.download_url);
        const parsed = JSON.parse(body);   // validate before writing
        // Stamp the SHA so a future sync can short-circuit.
        parsed._remoteSha = entry.sha;
        fs.writeFileSync(localRemote, JSON.stringify(parsed, null, 2), 'utf8');
        downloaded++;
      } catch (e) {
        failed++;
        console.warn(`kernel sync: skipped ${filename} — ${e.message}`);
      }
    }
    console.log(`kernel sync: ${downloaded} new, ${skipped} unchanged, ${failed} failed${manifestFetched ? '; manifest fetched' : '; manifest not fetched'}.`);
    return { ok: true, downloaded, skipped, failed, manifestFetched };
  } catch (e) {
    console.warn('kernel sync: failed —', e.message);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('sync-kernels-from-remote', () => syncKernelsFromRemote());

ipcMain.handle('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

// ── Card shell cache ──────────────────────────────────────────────────────────
//
// Strategy B persistence: the renderer process bakes ~50 (character, type,
// rarity) "shells" — the invariant frame/border/banner/plaque layers — and
// IPCs each PNG buffer here so it lands on disk under <userData>/Assets/
// shells/. Subsequent launches load the shells via appdata://shells/<key>.
// Skipping the heavy HSV math at runtime is the whole point.

ipcMain.handle('list-card-shells', () => {
  try {
    if (!fs.existsSync(shellsDir)) return [];
    return fs.readdirSync(shellsDir)
      .filter(f => f.endsWith('.png'))
      .map(f => f.slice(0, -4));
  } catch (_) { return []; }
});

ipcMain.handle('save-card-shell', (_event, key, base64Data) => {
  try {
    if (!key || typeof key !== 'string' || !/^[a-z0-9_]+$/.test(key)) return false;
    fs.mkdirSync(shellsDir, { recursive: true });
    const buf = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(path.join(shellsDir, `${key}.png`), buf);
    return true;
  } catch (_) { return false; }
});

ipcMain.handle('clear-card-shells', () => {
  try {
    if (fs.existsSync(shellsDir)) fs.rmSync(shellsDir, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
});

// ── Full card PNG cache (Strategy A) ──────────────────────────────────────────
//
// Pre-renders every (card, base|upgraded[, Mad Science rider]) into a PNG
// stashed under <userData>/Assets/cards-rendered/<key>.png. Runtime hydration
// then sets <img src> directly to the appdata:// URL, avoiding the canvas
// pipeline entirely (and the main-thread block that was making relics feel
// laggy too).

// images/cards/ has two kinds of children at different points in the
// pipeline: per-color portrait SUBFOLDERS (images/cards/silent/...) that
// only exist between [relocate] and the post-render wipe, plus the flat
// rendered PNG FILES that are the persistent runtime cache. List/save/
// clear only operate on the flat files so portraits never accidentally
// shadow or get wiped alongside the rendered cards.

ipcMain.handle('list-card-pngs', () => {
  try {
    if (!fs.existsSync(cardsRenderedDir)) return [];
    return fs.readdirSync(cardsRenderedDir, { withFileTypes: true })
      .filter(ent => ent.isFile() && ent.name.endsWith('.png'))
      .map(ent => ent.name.slice(0, -4));
  } catch (_) { return []; }
});

ipcMain.handle('save-card-png', (_event, key, base64Data) => {
  try {
    if (!key || typeof key !== 'string' || !/^[a-z0-9_]+$/.test(key)) return false;
    fs.mkdirSync(cardsRenderedDir, { recursive: true });
    const buf = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(path.join(cardsRenderedDir, `${key}.png`), buf);
    return true;
  } catch (_) { return false; }
});

ipcMain.handle('clear-card-pngs', () => {
  try {
    if (!fs.existsSync(cardsRenderedDir)) return true;
    for (const ent of fs.readdirSync(cardsRenderedDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.png')) {
        try { fs.unlinkSync(path.join(cardsRenderedDir, ent.name)); } catch (_) {}
      }
    }
    return true;
  } catch (_) { return false; }
});

// ── Resource updater ──────────────────────────────────────────────────────────

const resourceMetaPath = path.join(settingsDir, 'resource_meta.json');
const DATA_FILES = ['relics.json', 'cards.json', 'enchantments.json', 'events.json', 'potions.json'];

ipcMain.handle('check-data-exists', () => {
  return DATA_FILES.every(f => {
    const p = path.join(dataDir, f);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
});

ipcMain.handle('get-resource-meta', () => {
  try {
    if (fs.existsSync(resourceMetaPath))
      return JSON.parse(fs.readFileSync(resourceMetaPath, 'utf8'));
  } catch (_) {}
  return {};
});

ipcMain.handle('set-resource-meta', (_event, data) => {
  try {
    fs.writeFileSync(resourceMetaPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
});

let updateInProgress = false;
let updateProc       = null;
let updateCancelled  = false;

ipcMain.handle('cancel-update', () => {
  updateCancelled = true;
  if (updateProc) {
    try { updateProc.kill(); } catch (_) {}
    updateProc = null;
  }
  return true;
});

// Stream a progress line to the renderer. Reuses the existing
// `update-progress` channel so the existing UI log surface keeps working
// without changes; phase-aware UI can come later.
function sendUpdateProgress(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', { type, data });
  }
}

function logPhase(phase, message) {
  sendUpdateProgress('stdout', `[${phase}] ${message}`);
}

// In-place log update — used for noisy progress like download-percent ticks.
// The renderer interprets `type: 'progress'` as "replace the last log entry"
// instead of appending, so 0% → 1% → … → 100% takes one line not 100.
function logPhaseLive(phase, message) {
  sendUpdateProgress('progress', `[${phase}] ${message}`);
}

function allSimplifiedExist() {
  for (const f of DATA_FILES) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) return false;
  }
  return true;
}

// Move a directory tree, falling back to copy+delete when rename fails
// (cross-volume EXDEV). Removes any existing dst first so a re-run produces
// a clean target. Returns true on success, false when src didn't exist.
function moveDirectory(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  try {
    fs.renameSync(src, dst);
  } catch (_) {
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return true;
}

// After parse + simplify finish, the only remaining contents of extraction/
// we still need are the images and fonts. Move them under Assets/ so they
// get served via the existing `appdata://` protocol with paths that match
// the simplifier's `imageFile` prefix convention. Then drop the entire
// extraction tree to free disk (~200MB of decompiled C# we no longer need).
//
// Returns { movedCount, missing, deletePromise }: the synchronous moves
// finish before the function returns; the recursive rm of `extractionDir`
// (~15k files on Windows, the slow bit) runs in the background. Pipeline
// callers can ignore deletePromise — we don't await it.
function relocateExtractedAssetsAndCleanup() {
  // Image trees. Card portraits ARE migrated (under images/cards/) so the
  // [render] stage that follows can load them via `appdata://images/cards/...`
  // — same URL pattern the simplifier emits, no special handling. The card
  // portraits are wiped at the end of [render] (see dropPortraitsAfterBake)
  // since the rendered PNGs replace them at runtime.
  const moves = [
    { src: path.join(rawDir, 'images', 'packed', 'card_portraits'), dst: path.join(imagesDir, 'cards') },
    { src: path.join(rawDir, 'images', 'relics'),                   dst: path.join(imagesDir, 'relics') },
    { src: path.join(rawDir, 'images', 'events'),                   dst: path.join(imagesDir, 'events') },
    { src: path.join(rawDir, 'images', 'ancients'),                 dst: path.join(imagesDir, 'ancients') },
    { src: path.join(rawDir, 'images', 'monsters'),                 dst: path.join(imagesDir, 'monsters') },
    { src: path.join(rawDir, 'images', 'potions'),                  dst: path.join(imagesDir, 'potions') },
    { src: path.join(rawDir, 'images', 'enchantments'),             dst: path.join(imagesDir, 'enchantments') },
  ];
  let movedCount = 0, missing = [];
  for (const { src, dst } of moves) {
    const ok = moveDirectory(src, dst);
    if (ok) movedCount++;
    else    missing.push(path.relative(rawDir, src));
  }

  // Fonts get their own top-level dir under Assets/ — keeps appdata://fonts
  // resolvable without dipping into images/.
  const fontsDst = path.join(appdataBase, 'fonts');
  moveDirectory(path.join(rawDir, 'fonts'), fontsDst);

  // GDRE writes `<file>.png.import` sidecars next to every recovered image
  // (Godot's import-config files). They're useless to the dashboard and
  // bloat Assets/. Walk the target trees and drop them.
  const scrubbed = _scrubByExtension([imagesDir, fontsDst], '.import');

  // Returning here — extraction-dir delete and the post-render
  // images/cards/ drop happen in `wipePostRenderArtifacts` so the render
  // stage can rely on portraits still being on disk between this function
  // and itself.
  return { movedCount, missing, scrubbed };
}

// Drop everything the dashboard doesn't need at runtime: the per-color
// portrait SUBFOLDERS inside images/cards/ (their pixels are now baked
// into the flat rendered PNGs sitting alongside them), and the entire
// extraction scratch dir (PCK contents + decompiled C#). The flat
// rendered PNGs at the root of images/cards/ are preserved — those are
// what the dashboard hydrates from at runtime.
//
// Extraction rm is async-fire-and-forget — Windows takes 10-20s for
// ~15k files and we don't want to hold the pipeline overlay open for it.
function wipePostRenderArtifacts() {
  const cardsDir = path.join(imagesDir, 'cards');
  if (fs.existsSync(cardsDir)) {
    for (const ent of fs.readdirSync(cardsDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        try { fs.rmSync(path.join(cardsDir, ent.name), { recursive: true, force: true }); } catch (_) {}
      }
    }
  }
  let deletePromise = Promise.resolve();
  if (fs.existsSync(extractionDir)) {
    deletePromise = fs.promises.rm(extractionDir, { recursive: true, force: true })
      .catch(e => console.warn('async cleanup of extraction dir failed:', e.message));
  }
  return { deletePromise };
}

// Recursively delete any file whose name ends with `ext` under each of the
// given roots. Used to strip Godot's `.import` config sidecars after move,
// since they're meaningless to the dashboard. Returns the count removed.
function _scrubByExtension(roots, ext) {
  let removed = 0;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.toLowerCase().endsWith(ext)) {
        try { fs.unlinkSync(p); removed++; } catch (_) {}
      }
    }
  }
  for (const r of roots) walk(r);
  return removed;
}

// Drive the [render] stage from the main process. Bake work happens in the
// dashboard renderer (only context with canvas access); we send a trigger
// and wait on the completion event. Progress events arrive as
// `pipeline-bake-cards-progress` and get forwarded to the update overlay
// so the user sees per-card progress instead of a frozen bar.
function runRenderStage() {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error('main window not available'));
      return;
    }
    let stallTimer;
    const armStall = () => {
      stallTimer = setTimeout(() => {
        ipcMain.removeListener('pipeline-bake-cards-progress', onProgress);
        ipcMain.removeListener('pipeline-bake-cards-done', onDone);
        reject(new Error('render stage IPC trigger received no response after 60s — renderer listener may not be registered (check DevTools for [render-stage] log)'));
      }, 60_000);
    };
    const onProgress = (_e, data) => {
      // Reset the stall timer on every event so a slow bake doesn't trip
      // it. The renderer's `ack:true` event fires immediately on listener
      // entry so we know it's alive even before shell bake (~15-20s)
      // gives way to card-bake progress events.
      clearTimeout(stallTimer);
      armStall();
      if (!data || data.ack) return;        // ack-only event: don't pollute overlay
      const { done, total } = data;
      if (typeof total === 'number' && total > 0) {
        logPhaseLive('render', `Baking cards ${done}/${total}…`);
      }
    };
    const onDone = (_e, result) => {
      ipcMain.removeListener('pipeline-bake-cards-progress', onProgress);
      ipcMain.removeListener('pipeline-bake-cards-done', onDone);
      clearTimeout(stallTimer);
      if (result && result.error) reject(new Error(result.error));
      else resolve(result || { baked: 0, totalKeys: 0 });
    };
    armStall();
    ipcMain.on('pipeline-bake-cards-progress', onProgress);
    ipcMain.once('pipeline-bake-cards-done', onDone);
    logPhase('render', 'sending bake trigger to dashboard renderer…');
    mainWindow.webContents.send('pipeline-bake-cards-trigger');
  });
}

// End-to-end local-extraction pipeline. Replaces the deleted wiki-scrape
// path. Stages mirror mock-test-app's runPipeline:
//   detect Steam → install missing tools → GDRE PCK extract → dnSpy decompile
//   → spire-codex parsers → simplifier → render → relocate/cleanup → sync.
//   Output lands in:
//     <userData>/Tools/extraction/raw/         (PCK contents)
//     <userData>/Tools/extraction/decompiled/  (.cs sources)
//     <userData>/Assets/data-extracted/eng/    (parser JSON output)
//     <userData>/Assets/data/                  (simplifier JSON — final)
//     <userData>/Assets/cards-rendered/        (Strategy A: card PNGs)
async function runPipeline({ force = false } = {}) {
  if (!force && allSimplifiedExist()) {
    logPhase('ready', 'Cached simplified data found — skipping pipeline.');
    return { success: true, skipped: true };
  }

  const pipelineStart = Date.now();
  // Per-stage timer that logs the elapsed time to the same channel as the
  // stage's output so the user can see where the cost lives.
  const fmt = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const stageDone = (phase, t0) => logPhase(phase, `(${fmt(Date.now() - t0)})`);

  // 1. Detect Steam install / STS2
  let t0 = Date.now();
  logPhase('detect', 'Locating Steam install…');
  const steam = detectSteam();
  if (!steam.found) {
    const msg = `STS2 install not detected: ${(steam.errors || []).join('; ')}`;
    logPhase('error', msg);
    return { success: false, error: msg };
  }
  logPhase('detect', `Found STS2 ${steam.install.version} at ${steam.install.installDir}`);
  // Persist the detected game version so external tools (kernel-editor's
  // snapshot script) can label the basis correctly. The wiki's manifest
  // current_version may be ahead of what's actually installed, so we
  // record what was just extracted.
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    const meta = fs.existsSync(resourceMetaPath)
      ? JSON.parse(fs.readFileSync(resourceMetaPath, 'utf8'))
      : {};
    meta.gameVersion = steam.install.version;
    meta.detectedAt  = new Date().toISOString();
    fs.writeFileSync(resourceMetaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) { console.warn('save gameVersion to resource_meta failed:', e.message); }
  stageDone('detect', t0);

  // 2. Install tools if missing (graceful — skip when already cached).
  // Both tools are independent; install them in parallel. On first run
  // this halves wall-clock from ~45s → ~22s. On subsequent runs both are
  // cached and the stage finishes instantly anyway.
  t0 = Date.now();
  // Combined live progress line — track each tool's % independently so
  // they don't fight over the live log. Re-render the line whenever
  // either side ticks.
  const dlPct = { gdre: null, dnspy: null };
  const renderDlLine = () => {
    const parts = [];
    for (const t of ['gdre', 'dnspy']) {
      const pct = dlPct[t];
      if (pct == null) continue;
      parts.push(`${toolManager.TOOLS[t].label}: ${pct}%`);
    }
    if (parts.length) logPhaseLive('tools', `Downloading ${parts.join(' / ')}`);
  };
  const installOne = async (tool) => {
    if (updateCancelled) return;
    const status = toolManager.detectInstalled(tool);
    if (status.installed) {
      logPhase('tools', `${status.label} already cached (${status.version || 'unknown version'}).`);
      return;
    }
    logPhase('tools', `Installing ${toolManager.TOOLS[tool].label}…`);
    await toolManager.installTool(tool, (progress) => {
      if (progress.phase === 'downloading' && progress.total) {
        dlPct[tool] = Math.floor(progress.downloaded / progress.total * 100);
        renderDlLine();
      } else if (progress.message) {
        logPhase('tools', `${toolManager.TOOLS[tool].label}: ${progress.message}`);
      }
    });
    dlPct[tool] = null;
    const after = toolManager.detectInstalled(tool);
    logPhase('tools', `${after.label} ${after.version || ''} installed.`);
  };
  await Promise.all([installOne('gdre'), installOne('dnspy')]);
  if (updateCancelled) return { success: false, cancelled: true };
  stageDone('tools', t0);

  // 3+4. PCK extraction (GDRE) and DLL decompile (dnSpy) run in PARALLEL —
  // they're independent (GDRE reads the PCK, dnSpy reads sts2.dll, neither
  // needs the other's output until [parse]). Sequential ~26s + ~22s = ~48s;
  // parallel ~max(26, 22) = ~26s, saving ~22s.
  if (updateCancelled) return { success: false, cancelled: true };
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(decompiledDir, { recursive: true });

  // GDRE supports `--include=<glob>` (repeatable, rooted at res://) to extract
  // only the paths we care about, instead of all 15k+ files in the PCK.
  // `.godot/imported/**` must be included for image categories — each
  // `images/<cat>/foo.png.import` is a config file referencing a .ctex
  // binary in `.godot/imported/` that GDRE needs to read to recover the .png.
  const includeGlobs = [
    'images/packed/card_portraits/**',
    'images/relics/**',
    'images/events/**',
    'images/ancients/**',
    'images/monsters/**',
    'images/potions/**',
    'images/enchantments/**',
    // Map assets — backdrops, ancients, boss icon placeholders, ui_atlas
    // (referenced by .tres files for the room-type icons we slice ourselves),
    // plus the Spine atlas + sprite-sheet PNGs for the 3 animated bosses
    // (Ceremonial Beast / False Queen / The Insatiable) which we slice into
    // standalone <name>_boss_icon.png files via parseSpineAtlas.
    'images/packed/map/**',
    'images/map/placeholder/**',
    'images/atlases/ui_atlas_*.png',
    'images/atlases/ui_atlas.sprites/map/**',
    'animations/map/**/boss_node_*.png',
    'animations/map/**/*_boss_node.atlas',
    '.godot/imported/**',
    'localization/eng/**',
    'fonts/kreon_*.ttf',
  ];

  const extractJob = (async () => {
    const xt0 = Date.now();
    logPhase('extract', 'Extracting Godot PCK (GDRE Tools)…');
    const result = await toolManager.runTool('gdre', [
      '--headless',
      `--recover=${steam.install.pckPath}`,
      `--output=${rawDir}`,
      ...includeGlobs.map(g => `--include=${g}`),
    ], {
    // GDRE is chatty — thousands of "extracting <file>" lines plus a CR-
    // redrawn progress bar. Stream non-error output as live (single in-place
    // line) so the user sees activity without flooding; preserve real errors
    // as appended entries so they don't get overwritten.
    onLine: ({ line }) => {
      if (!line) return;
      // Take only the final segment after CR redraws (so we get the latest
      // "Extracting files... 87%" instead of a smush of 0% through current),
      // and strip ANSI cursor / color codes.
      const t = line.split(/[\r\b]/).pop()
                    .replace(/\[[0-9;]*[a-zA-Z]/g, '')
                    .trim();
      if (!t) return;
      // Suppress known-benign noise: GDRE's .tscn parser bails on
      // `scenes/debug/back_confirm_example.tscn` (a Godot debug scene with
      // a broken resource ref at line 21) and follows it with a canned
      // "Please include this file…" line. We don't read .tscn files
      // anyway — all dashboard data comes from the C# decompile, so this
      // error has no effect downstream.
      // Suppress GDRE's per-file resource warnings — they're benign,
      // GDRE continues, and the dashboard never reads .tscn anyway. Loose
      // patterns here (any "scenes/debug" path, any "Parse Error", and
      // the canned "Please include this file" follow-up) so a future
      // GDRE update tweaking the error format doesn't sneak through.
      if (/scenes\/debug/i.test(t)) return;
      if (/^ERROR:\s*Parse Error/i.test(t)) return;
      if (/^Please include this file when reporting issues/i.test(t)) return;
      // GDRE's post-extraction "Recreating plugin configs…" pass tries to
      // re-emit addon files (Sentry plugin's logo.svg etc.). The dashboard
      // include-filter excludes addon paths, so those write attempts fail
      // with `Cannot write to file: …/addons/...`. The dashboard reads
      // none of this, so suppress all addon-pass output.
      if (/addons\//i.test(t)) return;
      if (/^\* Errors:?$/i.test(t)) return;          // GDRE section header
      if (/error/i.test(t))  logPhase('extract', t.slice(0, 200));
      else                   logPhaseLive('extract', t.slice(0, 140));
    },
    });
    stageDone('extract', xt0);
    return result;
  })();

  const decompileJob = (async () => {
    const dt0 = Date.now();
    logPhase('decompile', 'Decompiling sts2.dll (dnSpy)…');
    // dnSpy is mostly silent during its run (output buffered until close on
    // many Windows setups). Don't use logPhaseLive in parallel mode — every
    // dnSpy non-error line would clobber GDRE's live progress bar. Errors
    // still surface as appended entries.
    const result = await toolManager.runTool('dnspy', [
      '--no-sln',
      // Skip work the parsers don't read — trims ~10-15% off the run.
      '--no-resources', '--no-resx', '--no-baml',
      '--dont-xml-doc', '--dont-tokens',
      '-o', decompiledDir, steam.install.dllPath,
    ], {
      cwd: path.dirname(steam.install.dllPath),
      onLine: ({ line }) => {
        if (!line) return;
        const t = line.split(/[\r\b]/).pop()
                      .replace(/\[[0-9;]*[a-zA-Z]/g, '')
                      .trim();
        if (!t) return;
        if (/error/i.test(t)) logPhase('decompile', t.slice(0, 200));
      },
    });
    logPhase('decompile', 'Decompile complete.');
    stageDone('decompile', dt0);
    return result;
  })();

  const [gdreResult, dnspyResult] = await Promise.all([extractJob, decompileJob]);
  if (gdreResult.code !== 0) {
    const msg = `GDRE Tools exited with code ${gdreResult.code}.`;
    logPhase('error', msg);
    return { success: false, error: msg };
  }
  if (dnspyResult.code !== 0) {
    const msg = `dnSpy exited with code ${dnspyResult.code}.`;
    logPhase('error', msg);
    return { success: false, error: msg };
  }

  // 5. Run JS parsers
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('parse', 'Running JS parsers…');
  const locDir = path.join(rawDir, 'localization', 'eng');
  const IMG = (sub) => path.join(rawDir, 'images', sub);
  fs.mkdirSync(extractedDir, { recursive: true });

  const PARSERS = [
    { key: 'potions',      mod: potionParser, fn: 'parseAllPotions',
      opts: { decompiledRoot: decompiledDir, locDir, imagesDir: IMG('potions') } },
    { key: 'enchantments', mod: enchParser,   fn: 'parseAllEnchantments',
      opts: { decompiledRoot: decompiledDir, locDir, imagesDir: IMG('enchantments') } },
    { key: 'relics',       mod: relicParser,  fn: 'parseAllRelics',
      opts: { decompiledRoot: decompiledDir, locDir, imagesDir: IMG('relics') } },
    { key: 'cards',        mod: cardParser,   fn: 'parseAllCards',
      opts: { decompiledRoot: decompiledDir, locDir, imagesDir: IMG(path.join('packed', 'card_portraits')) } },
    { key: 'events',       mod: eventParser,  fn: 'parseAllEvents',
      opts: { decompiledRoot: decompiledDir, locDir, imagesDir: IMG('events'),
              ancientImagesDir: IMG('ancients'), monsterImagesDir: IMG('monsters'),
              relicDataPath: path.join(extractedDir, 'relics.json') } },
  ];
  const parseCounts = {};
  for (const spec of PARSERS) {
    if (updateCancelled) return { success: false, cancelled: true };
    logPhase('parse', `Parsing ${spec.key}…`);
    const arr = spec.mod[spec.fn](spec.opts);
    fs.writeFileSync(path.join(extractedDir, `${spec.key}.json`),
                     JSON.stringify(arr, null, 2), 'utf8');
    parseCounts[spec.key] = arr.length;
  }
  logPhase('parse', `Parsed ${JSON.stringify(parseCounts)}`);
  stageDone('parse', t0);

  // 6. Simplify into the dashboard's render-ready schema
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('simplify', 'Condensing to render-ready schema…');
  const simpleCounts = simplifyAll(extractedDir, dataDir);
  logPhase('simplify', `Simplified ${JSON.stringify(simpleCounts)}`);
  stageDone('simplify', t0);

  // 7. Move images + fonts into Assets/ first, BEFORE the render stage,
  //    so portraits resolve via the regular `appdata://images/cards/...`
  //    URL while the bake is running. (Skipping migration was tempting
  //    for "no leftover portraits" but caused silent extracted:// load
  //    failures during bake — the rendered cards came out with black
  //    portrait windows. Migrate first, drop after.)
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('relocate', 'Moving images + fonts into Assets/…');
  const relocate = relocateExtractedAssetsAndCleanup();
  logPhase('relocate',
    `Relocated ${relocate.movedCount} image dirs; scrubbed ${relocate.scrubbed} .import sidecars.`
    + (relocate.missing.length ? ` Missing in extraction: ${relocate.missing.join(', ')}.` : ''));
  stageDone('relocate', t0);

  // 7b. Map assets: copy ancient + boss-placeholder PNGs, slice ui_atlas
  // regions for room-type icons, copy per-act parchment backdrops. Sources
  // live under rawDir's images/packed/map and images/atlases — both
  // untouched by the relocate above, so they're still on disk here.
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('map-assets', 'Slicing map node icons + copying backdrops…');
  try {
    const mapResult = processStagedMapAssets({
      stagingDir: rawDir,
      outputDir:  imagesDir,
      onProgress: (p) => logPhase('map-assets', p.message),
    });
    logPhase('map-assets', `Wrote ${mapResult.icons.length} icons + ${mapResult.backdrops.length} backdrops.`
      + (mapResult.skipped.length ? ` (${mapResult.skipped.length} atlas slices skipped)` : ''));
  } catch (e) {
    // Non-fatal: maps will fall back to letter symbols if assets are missing.
    logPhase('map-assets', `Map asset extraction failed (non-fatal): ${e.message}`);
  }
  stageDone('map-assets', t0);

  // 8. Sync kernels + map icons from the GitHub repo. We do this BEFORE
  //    [render] so the render stage's bake walks the freshly-fetched
  //    kernels and produces versioned PNGs in one shot. (The app no
  //    longer ships bundled kernels — they live in the GitHub repo and
  //    are fetched on every pipeline run.) Failure is logged but doesn't
  //    abort the pipeline; offline runs still produce current-data PNGs.
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('sync', 'Checking GitHub for kernel updates…');
  const syncResult = await syncKernelsFromRemote();
  if (syncResult.ok) {
    const tail = syncResult.failed ? `, ${syncResult.failed} failed` : '';
    logPhase('sync', `Kernel sync: ${syncResult.downloaded} new, ${syncResult.skipped} unchanged${tail}.`);
  } else {
    logPhase('sync', `Kernel sync skipped (${syncResult.error || 'offline'}).`);
  }
  stageDone('sync', t0);

  // 9. Render every card to a static PNG (Strategy A). Hands off to the
  //    main BrowserWindow's renderer process — that's where canvas-2D
  //    lives — and waits for it to finish baking. Portraits load via
  //    `appdata://images/cards/...` (on disk after the relocate step).
  //    The renderer-side helper re-fetches the kernel bundle here, so
  //    kernels just synced above are picked up for versioned-PNG bakes.
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('render', 'Rendering card images…');
  try {
    const bakeResult = await runRenderStage();
    logPhase('render', `Baked ${bakeResult.baked} card PNGs (${bakeResult.totalKeys} keys total).`);
  } catch (e) {
    logPhase('error', `Render stage failed: ${e.message}`);
    return { success: false, error: `render: ${e.message}` };
  }
  stageDone('render', t0);

  // 10. Wipe the post-render leftovers: portraits (pixels now baked into
  //     rendered PNGs) and the entire extraction scratch dir. Extraction
  //     rm is async — pipeline returns "ready" while NTFS chews through
  //     ~15k file deletes in the background.
  if (updateCancelled) return { success: false, cancelled: true };
  t0 = Date.now();
  logPhase('cleanup', 'Dropping card portraits + extraction scratch dir…');
  wipePostRenderArtifacts();
  stageDone('cleanup', t0);

  logPhase('ready', `Pipeline complete in ${fmt(Date.now() - pipelineStart)}.`);
  return { success: true, parseCounts, simpleCounts, kernelSync: syncResult };
}

ipcMain.handle('run-update-resources', async () => {
  if (updateInProgress) return { error: 'Update already running' };
  updateInProgress = true;
  updateCancelled  = false;
  try {
    const result = await runPipeline({ force: true });
    return result;
  } catch (e) {
    logPhase('error', e.message);
    return { success: false, error: e.message };
  } finally {
    updateInProgress = false;
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // Serve files from %APPDATA%/STS2S/assets via appdata:// scheme
  const fileUrl = (absPath) => 'file:///' + encodeURI(absPath.replace(/\\/g, '/'));

  protocol.handle('appdata', (request) => {
    const url = request.url.slice('appdata://'.length);
    const filePath = path.join(appdataBase, decodeURIComponent(url));
    return net.fetch(fileUrl(filePath));
  });
  protocol.handle('extracted', (request) => {
    const url = request.url.slice('extracted://'.length);
    const filePath = path.join(rawDir, decodeURIComponent(url));
    return net.fetch(fileUrl(filePath));
  });
  // `card render assets/` ships inside the .exe (asar archive in
  // production builds). Two things to handle:
  //   1. `net.fetch('file://...')` can't resolve paths inside an asar
  //      archive — read with `fs.readFile` (Electron patches it for
  //      asar) and return a Response with the bytes directly.
  //   2. URL hosts get lowercased by URL normalization, so the renderer
  //      uses the 3-slash form `cardassets:///Frame/foo.png` to keep
  //      the directory name in the case-preserving PATH portion. We
  //      strip a single leading slash here for path.join.
  protocol.handle('cardassets', async (request) => {
    const sub  = request.url.slice('cardassets://'.length).replace(/^\//, '');
    const filePath = path.join(CARD_ASSETS_DIR, decodeURIComponent(sub));
    try {
      const buf = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.png'  ? 'image/png'  :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.svg'  ? 'image/svg+xml' :
        ext === '.ttf'  ? 'font/ttf' :
        'application/octet-stream';
      return new Response(buf, { headers: { 'Content-Type': contentType } });
    } catch (e) {
      return new Response(`cardassets not found: ${sub}`, { status: 404 });
    }
  });

  const config = readConfig();

  if (config && config.historyFolder && fs.existsSync(config.historyFolder)) {
    createWindow('index.html');
    startWatcher(config.historyFolder);
  } else {
    createWindow('setup.html');
  }

  // Best-effort kernel sync from GitHub — fire-and-forget so launch isn't
  // blocked by network latency. Silent on failure; the pipeline runs it
  // again on any subsequent Update Resources click.
  syncKernelsFromRemote().catch(() => {});

  app.on('activate', () => {
    if (mainWindow === null) {
      const cfg = readConfig();
      if (cfg && cfg.historyFolder && fs.existsSync(cfg.historyFolder)) {
        createWindow('index.html');
      } else {
        createWindow('setup.html');
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
