'use strict';
/**
 * steam_detect.js — Locate Steam, walk its libraries, find the STS2 install.
 *
 * Returns a "detection result" object the renderer can consume directly:
 *   {
 *     found:        boolean,
 *     steamPath:    string | null,
 *     libraries:    [{ index, path }, …],
 *     install: {                   // only present when found === true
 *       libraryPath: string,       // e.g. "G:\SteamLibrary"
 *       installDir:  string,       // "<libraryPath>/steamapps/common/<installdir>"
 *       installdir:  string,       // raw installdir from .acf
 *       name:        string,       // "Slay the Spire 2"
 *       buildId:     string,       // Steam build id (e.g. "22823976")
 *       betaKey:     string,       // "public" or beta branch name
 *       sizeOnDisk:  string,
 *       lastUpdated: string,
 *     } | null,
 *     errors:       [string, …]    // soft errors collected along the way
 *   }
 *
 * Cross-platform-ish: the auto-detect path list covers Windows, macOS, and
 * Linux defaults. If none of those exist, the caller is expected to prompt
 * the user for a custom Steam path (BYO-path flow).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const { parse } = require('./vdf_parser.js');

const STS2_APP_ID = '2868840';

// Default install paths per OS — first match wins. These cover ~95% of users.
function defaultSteamCandidates() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return [
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
      ];
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Steam')];
    case 'linux':
      return [
        path.join(home, '.steam', 'steam'),
        path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
      ];
    default:
      return [];
  }
}

// Windows-only fallback: read the Steam install path out of the registry.
// Avoids the corner case where Steam is installed somewhere non-default.
function windowsRegistrySteamPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam',              'InstallPath'],
    ['HKCU\\SOFTWARE\\Valve\\Steam',              'SteamPath'],
  ];
  for (const [key, name] of candidates) {
    try {
      const result = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' });
      if (result.status !== 0) continue;
      // Output line looks like:    "    InstallPath    REG_SZ    C:\Program Files (x86)\Steam"
      const m = result.stdout.match(new RegExp(name + '\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)\\s*$', 'm'));
      if (m && m[1]) return m[1].trim();
    } catch (_) { /* registry query failed — try next */ }
  }
  return null;
}

function findSteamPath() {
  for (const candidate of defaultSteamCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const reg = windowsRegistrySteamPath();
  if (reg && fs.existsSync(reg)) return reg;
  return null;
}

function readLibraryFolders(steamPath) {
  const lf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (!fs.existsSync(lf)) {
    throw new Error(`libraryfolders.vdf not found at ${lf}`);
  }
  const parsed = parse(fs.readFileSync(lf, 'utf8'));
  // libraryfolders.vdf wraps everything in `"libraryfolders" { "0" {…} … }`.
  // Each numbered child has at least a `path` field.
  const out = [];
  for (const [idx, lib] of Object.entries(parsed)) {
    if (!lib || typeof lib !== 'object' || !lib.path) continue;
    out.push({ index: idx, path: lib.path, apps: lib.apps || {} });
  }
  return out;
}

function findStsTwoInLibrary(library) {
  const acfPath = path.join(library.path, 'steamapps', `appmanifest_${STS2_APP_ID}.acf`);
  if (!fs.existsSync(acfPath)) return null;
  let acf;
  try { acf = parse(fs.readFileSync(acfPath, 'utf8')); }
  catch (e) { return { _error: `failed to parse ${acfPath}: ${e.message}` }; }
  if (!acf.installdir) return null;

  const installDir = path.join(library.path, 'steamapps', 'common', acf.installdir);

  // Read release_info.json from the install dir for the actual semver
  // version + commit. Steam's `buildid` is a numeric build counter that
  // doesn't map cleanly to patch-note versions, so the JSON is what we
  // want to match against the kernel manifest.
  const releaseInfoPath = path.join(installDir, 'release_info.json');
  let releaseInfo = null;
  if (fs.existsSync(releaseInfoPath)) {
    try { releaseInfo = JSON.parse(fs.readFileSync(releaseInfoPath, 'utf8')); }
    catch (e) { /* ignore — leave null and fall back to buildid */ }
  }

  // The PCK and DLL paths the extraction pipeline operates on.
  const pckPath = path.join(installDir, 'SlayTheSpire2.pck');
  const dllPath = path.join(installDir, 'data_sts2_windows_x86_64', 'sts2.dll');

  return {
    libraryPath: library.path,
    installDir,
    installdir:  acf.installdir,
    name:        acf.name        || 'Slay the Spire 2',
    buildId:     acf.buildid     || null,
    betaKey:     acf.UserConfig?.BetaKey || acf.MountedConfig?.BetaKey || 'public',
    sizeOnDisk:  acf.SizeOnDisk  || null,
    lastUpdated: acf.LastUpdated || null,
    // From release_info.json — present iff the file exists and parses.
    version:     releaseInfo?.version || null,
    commit:      releaseInfo?.commit  || null,
    versionDate: releaseInfo?.date    || null,
    branch:      releaseInfo?.branch  || null,
    // Pre-resolved input paths for the extraction pipeline. existsSync at
    // detect-time so the renderer can show a quick "ready / missing" status
    // without having to build paths itself.
    pckPath,
    dllPath,
    pckExists:   fs.existsSync(pckPath),
    dllExists:   fs.existsSync(dllPath),
  };
}

/**
 * Detect Steam + STS2 install. Optionally pass `customSteamPath` to skip
 * default-path discovery (for BYO-path flows).
 */
function detect(customSteamPath = null) {
  const errors = [];
  const steamPath = customSteamPath || findSteamPath();
  if (!steamPath) {
    return {
      found: false, steamPath: null, libraries: [], install: null,
      errors: ['Could not locate Steam — no default install path exists. ' +
               'Pick the Steam folder manually (BYO-path).'],
    };
  }

  let libraries;
  try { libraries = readLibraryFolders(steamPath); }
  catch (e) {
    return {
      found: false, steamPath, libraries: [], install: null,
      errors: [e.message],
    };
  }

  for (const lib of libraries) {
    const hit = findStsTwoInLibrary(lib);
    if (!hit) continue;
    if (hit._error) { errors.push(hit._error); continue; }
    return {
      found:     true,
      steamPath,
      libraries: libraries.map(l => ({ index: l.index, path: l.path })),
      install:   hit,
      errors,
    };
  }

  return {
    found:     false,
    steamPath,
    libraries: libraries.map(l => ({ index: l.index, path: l.path })),
    install:   null,
    errors:    errors.concat([`Slay the Spire 2 (app id ${STS2_APP_ID}) not installed in any Steam library.`]),
  };
}

module.exports = { detect, STS2_APP_ID };
