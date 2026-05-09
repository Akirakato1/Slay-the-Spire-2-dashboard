'use strict';
/**
 * tool_manager.js — Detection / install / launch primitives for the external
 * tools used by the local-extraction pipeline (GDRE Tools, ILSpy CLI).
 *
 * Cache layout under `%APPDATA%\sts2-dashboard\Tools\`:
 *   gdre\
 *     gdre_tools.exe                ← the executable we invoke
 *     <other DLLs / data shipped alongside>
 *     _meta.json                    ← { version, installedAt, sourceUrl }
 *   ilspy\
 *     ilspycmd.exe
 *     _meta.json
 *
 * Each tool has a "spec" that knows:
 *   - where its executable lives inside the cache dir
 *   - the GitHub repo to query for new releases
 *   - which release asset to pick for the current OS (a regex over asset
 *     filenames — assets vary across releases, so we don't hardcode names)
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const { spawn } = require('child_process');

// Electron's `app` module is only available when this file is required from
// the main process. The standalone orchestrator (`scripts/run_extraction.js`)
// imports tool_manager directly and runs without Electron, so we soft-import
// `app` and fall back to a platform-default userData path.
let _electronApp = null;
try { _electronApp = require('electron').app; } catch (_) {}

function _defaultUserDataPath() {
  if (_electronApp) return _electronApp.getPath('userData');
  // Match Electron's default for an app whose name is "sts2-dashboard"
  // (declared in package.json). On Windows that's %APPDATA%\sts2-dashboard;
  // on macOS ~/Library/Application Support/sts2-dashboard; on Linux
  // ~/.config/sts2-dashboard.
  const APP_NAME = 'sts2-dashboard';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

// ── Tool specs ──────────────────────────────────────────────────────────────

const TOOLS = {
  gdre: {
    repo:        'GDRETools/gdsdecomp',
    // The Windows asset is currently named like `GDRE_tools-1.x.x-windows.zip`
    // but we match by suffix so future renames don't break us.
    assetMatch:  { win32: /windows.*\.zip$/i, linux: /linux.*\.zip$/i, darwin: /(macos|osx).*\.zip$/i },
    executable:  { win32: 'gdre_tools.exe', linux: 'gdre_tools', darwin: 'gdre_tools' },
    label:       'GDRE Tools',
    licenseNote: 'MIT',
  },
  dnspy: {
    repo:        'dnSpyEx/dnSpy',
    // The `dnSpy-netframework.zip` build is .NET Framework (4.x) — already
    // present on every Windows 10/11 box, no runtime install needed. The
    // .NET (Core) builds are bigger and require a matching runtime, so we
    // skip them. Linux/macOS aren't officially supported by dnSpy.
    assetMatch: {
      win32:  /dnSpy-netframework\.zip$/i,
      linux:  /__never_match__/,
      darwin: /__never_match__/,
    },
    executable:  { win32: 'dnSpy.Console.exe', linux: 'dnSpy.Console', darwin: 'dnSpy.Console' },
    label:       'dnSpy Console',
    licenseNote: 'GPL-3.0 (dnSpyEx fork)',
  },
};

function toolsRoot() {
  return path.join(_defaultUserDataPath(), 'Tools');
}

function toolDir(name) {
  return path.join(toolsRoot(), name);
}

function metaPath(name) {
  return path.join(toolDir(name), '_meta.json');
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * @returns {{
 *   installed: boolean,
 *   executablePath: string | null,
 *   version: string | null,
 *   sourceUrl: string | null,
 *   installedAt: string | null,
 *   label: string,
 * }}
 */
function detectInstalled(name) {
  const spec = TOOLS[name];
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  const dir  = toolDir(name);
  const exe  = path.join(dir, spec.executable[process.platform] || spec.executable.linux);
  const meta = (() => {
    try {
      if (fs.existsSync(metaPath(name))) return JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
    } catch (_) {}
    return {};
  })();
  return {
    installed:      fs.existsSync(exe),
    executablePath: fs.existsSync(exe) ? exe : null,
    version:        meta.version     || null,
    sourceUrl:      meta.sourceUrl   || null,
    installedAt:    meta.installedAt || null,
    label:          spec.label,
  };
}

function detectAll() {
  const out = {};
  for (const name of Object.keys(TOOLS)) out[name] = detectInstalled(name);
  return out;
}

// ── GitHub releases ─────────────────────────────────────────────────────────

function ghFetch(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'sts2-dashboard',
        'Accept':     'application/vnd.github+json',
      },
    };
    https.get(url, opts, (res) => {
      // Follow one redirect (releases sometimes 302 to a CDN URL)
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(ghFetch(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GitHub API ${url} → HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('GitHub API response was not valid JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch the latest release for a tool and pick the asset for the current OS.
 * Returns { tagName, publishedAt, asset: { name, url, size } | null, allAssets: [...] }.
 * Renderer may show `allAssets[]` if no asset matches and let the user override.
 */
async function fetchLatestRelease(name) {
  const spec = TOOLS[name];
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  const url  = `https://api.github.com/repos/${spec.repo}/releases/latest`;
  const data = await ghFetch(url);
  const matcher = spec.assetMatch[process.platform];
  const assets = (data.assets || []).map(a => ({
    name: a.name, url: a.browser_download_url, size: a.size, contentType: a.content_type,
  }));
  const asset = matcher ? assets.find(a => matcher.test(a.name)) : null;
  return {
    tagName:     data.tag_name,
    publishedAt: data.published_at,
    htmlUrl:     data.html_url,
    asset:       asset || null,
    allAssets:   assets,
  };
}

// ── Download (streamed) ─────────────────────────────────────────────────────
//
// Stream the asset to disk. Calls `onProgress({downloaded, total})` whenever
// new data arrives. Resolves with the destination path. The renderer is
// responsible for showing a progress bar from those events.

function downloadAsset(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tryGet = (currentUrl, hops = 0) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      https.get(currentUrl, { headers: { 'User-Agent': 'sts2-dashboard' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          return tryGet(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download ${currentUrl} → HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const sink = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) onProgress({ downloaded, total });
        });
        res.pipe(sink);
        sink.on('finish', () => sink.close(() => resolve(destPath)));
        sink.on('error', (e) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(e); });
      }).on('error', reject);
    };
    tryGet(url);
  });
}

// ── Extract zip ─────────────────────────────────────────────────────────────
//
// Use the platform's built-in unzipper. Node has no built-in zip support, but
// every OS we care about has a CLI: PowerShell `Expand-Archive` on Windows,
// `unzip` on Linux, `ditto` or `unzip` on macOS.

function extractZip(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(outDir)} -Force`];
    } else {
      cmd = 'unzip'; args = ['-o', zipPath, '-d', outDir];
    }
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      if (code === 0) return resolve(outDir);
      reject(new Error(`Extraction failed (exit ${code}): ${stderr.trim().slice(0, 500)}`));
    });
    p.on('error', reject);
  });
}

// ── Install (full flow) ─────────────────────────────────────────────────────

/**
 * Download + extract a tool's latest release into its cache dir. Wipes any
 * previous install in that dir first. `onProgress` shape:
 *   { phase: 'fetching-release' | 'downloading' | 'extracting' | 'done',
 *     downloaded?, total?, message? }
 */
async function installTool(name, onProgress = () => {}) {
  const spec = TOOLS[name];
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  onProgress({ phase: 'fetching-release', message: `Querying ${spec.label} latest release…` });

  const release = await fetchLatestRelease(name);
  if (!release.asset) {
    throw new Error(`No matching ${spec.label} asset for ${process.platform}. Available: ` +
      release.allAssets.map(a => a.name).join(', '));
  }

  const dir = toolDir(name);
  // Wipe stale install
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });

  const zipPath = path.join(dir, '_download.zip');
  onProgress({ phase: 'downloading', message: `Downloading ${release.asset.name}…`,
               total: release.asset.size, downloaded: 0 });
  await downloadAsset(release.asset.url, zipPath, ({ downloaded, total }) => {
    onProgress({ phase: 'downloading', downloaded, total });
  });

  onProgress({ phase: 'extracting', message: 'Extracting…' });
  await extractZip(zipPath, dir);
  try { fs.unlinkSync(zipPath); } catch (_) {}

  // Some tools nest their executable inside a versioned subfolder (e.g.
  // `gdre_tools-1.x.x-windows/`). Flatten one level if our expected
  // executable isn't at the top.
  const expectedExe = path.join(dir, spec.executable[process.platform] || spec.executable.linux);
  if (!fs.existsSync(expectedExe)) {
    const subdirs = fs.readdirSync(dir).filter(e => fs.statSync(path.join(dir, e)).isDirectory());
    for (const sd of subdirs) {
      const candidate = path.join(dir, sd, spec.executable[process.platform] || spec.executable.linux);
      if (fs.existsSync(candidate)) {
        // Move every file from the nested subdir up one level.
        for (const e of fs.readdirSync(path.join(dir, sd))) {
          fs.renameSync(path.join(dir, sd, e), path.join(dir, e));
        }
        fs.rmdirSync(path.join(dir, sd));
        break;
      }
    }
  }

  fs.writeFileSync(metaPath(name), JSON.stringify({
    version:     release.tagName,
    sourceUrl:   release.asset.url,
    installedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  onProgress({ phase: 'done', message: `${spec.label} ${release.tagName} ready.` });
  return detectInstalled(name);
}

// ── Run a tool ──────────────────────────────────────────────────────────────
//
// Spawn the cached executable. Streams stdout/stderr lines via `onLine` so the
// renderer can show live progress. Resolves with the exit code.

function runTool(name, args, { onLine, cwd } = {}) {
  const detected = detectInstalled(name);
  if (!detected.installed) {
    return Promise.reject(new Error(`${TOOLS[name].label} is not installed.`));
  }
  return new Promise((resolve, reject) => {
    const p = spawn(detected.executablePath, args, {
      cwd:   cwd || toolDir(name),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    function lineStream(stream, kind) {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line && onLine) onLine({ kind, line });
        }
      });
      stream.on('end', () => { if (buf && onLine) onLine({ kind, line: buf }); });
    }
    lineStream(p.stdout, 'stdout');
    lineStream(p.stderr, 'stderr');
    p.on('close', (code) => resolve({ code }));
    p.on('error', reject);
  });
}

module.exports = {
  TOOLS, toolsRoot, toolDir,
  detectInstalled, detectAll,
  fetchLatestRelease, installTool, runTool,
};
