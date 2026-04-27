const { app, BrowserWindow, ipcMain, dialog, utilityProcess, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Must be called before app.ready — allows fetch() and <img> to use appdata://
protocol.registerSchemesAsPrivileged([
  { scheme: 'appdata', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow = null;
let watcher = null;
const appdataBase   = path.join(app.getPath('userData'), 'Assets');
const settingsDir   = path.join(appdataBase, 'settings');
const configPath    = path.join(settingsDir, 'config.json');
const favoritesPath = path.join(settingsDir, 'favorites.json');

// Ensure required asset directories exist on first run
const dataDir       = path.join(appdataBase, 'data');
const imagesDir     = path.join(appdataBase, 'images');
const sharedRunsDir = path.join(app.getPath('userData'), 'Shared Runs');
try { fs.mkdirSync(settingsDir,   { recursive: true }); } catch (_) {}
try { fs.mkdirSync(dataDir,       { recursive: true }); } catch (_) {}
try { fs.mkdirSync(imagesDir,     { recursive: true }); } catch (_) {}
try { fs.mkdirSync(sharedRunsDir, { recursive: true }); } catch (_) {}

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

ipcMain.handle('run-update-resources', async () => {
  if (updateInProgress) return { error: 'Update already running' };
  updateInProgress = true;
  updateCancelled  = false;

  const scriptPath = path.join(__dirname, '..', 'scripts', 'update_wiki_data.js');

  if (!fs.existsSync(scriptPath)) {
    updateInProgress = false;
    return { error: 'Update script not found.' };
  }

  const sendProgress = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { type, data });
    }
  };

  return new Promise((resolve) => {
    const child = utilityProcess.fork(scriptPath, [], {
      stdio: 'pipe',
      env: {
        ...process.env,
        STS2_CONFIG: JSON.stringify({
          dataDir, imagesDir, settingsDir,
          what: 'all', dryRun: false, forceImages: false,
        }),
      },
    });

    updateProc = child;

    // Line-buffer stdout and stderr so each log line arrives as one message
    function pipeLines(stream, type) {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) sendProgress(type, line);
        }
      });
      stream.on('end', () => { if (buf.trim()) sendProgress(type, buf.trim()); });
    }

    if (child.stdout) pipeLines(child.stdout, 'stdout');
    if (child.stderr) pipeLines(child.stderr, 'stderr');

    child.on('exit', (code) => {
      updateProc = null;
      updateInProgress = false;
      resolve({ success: !updateCancelled && code === 0, code, cancelled: updateCancelled });
    });
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // Serve files from %APPDATA%/STS2S/assets via appdata:// scheme
  protocol.handle('appdata', (request) => {
    const url = request.url.slice('appdata://'.length);
    const filePath = path.join(appdataBase, url);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });

  const config = readConfig();

  if (config && config.historyFolder && fs.existsSync(config.historyFolder)) {
    createWindow('index.html');
    startWatcher(config.historyFolder);
  } else {
    createWindow('setup.html');
  }

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
