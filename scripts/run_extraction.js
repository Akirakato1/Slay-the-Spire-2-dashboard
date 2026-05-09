'use strict';
/**
 * run_extraction.js — Standalone end-to-end driver for the local-extraction
 * pipeline. Runs without Electron so we can iterate / debug on the CLI
 * before wiring the flow into the dashboard UI.
 *
 * Usage:
 *   node scripts/run_extraction.js [stage]
 *
 * Stages (each can be run individually; the default with no arg is "all"):
 *   detect          Steam install detection
 *   tools           Show installed tool status
 *   install-gdre    Download + extract GDRE Tools
 *   install-dnspy   Download + extract dnSpy Console (the decompiler)
 *   install-tools   Both of the above
 *   extract-pck     Run GDRE on the game's .pck → raw/
 *   decompile       Run dnSpy.Console on sts2.dll → decompiled/
 *   parse           Run JS parsers on decompiled/ + raw/localization/
 *   all             detect → install missing → extract → decompile → parse
 *   probe-gdre      Print GDRE Tools --help (figure out CLI flags)
 *   probe-dnspy     Print dnSpy.Console --help
 *
 * Cache paths match the Electron app's so installs / extractions are
 * reused: %APPDATA%\sts2-dashboard\Tools\…
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const tm        = require('../src/tools/tool_manager.js');
const { detect: detectSteam } = require('../src/tools/steam_detect.js');

const TOOLS_ROOT     = tm.toolsRoot();
const EXTRACTION_DIR = path.join(TOOLS_ROOT, 'extraction');
const RAW_DIR        = path.join(EXTRACTION_DIR, 'raw');
const DECOMPILED_DIR = path.join(EXTRACTION_DIR, 'decompiled');

// Where the final parsed JSON lands. Sibling to the wiki-scraped Assets/data
// so we can compare side-by-side without overwriting anything.
const ASSETS_ROOT      = path.join(path.dirname(TOOLS_ROOT), 'Assets');
const EXTRACTED_OUTPUT = path.join(ASSETS_ROOT, 'data-extracted');

// Default localization language (spire-codex parsers were written multi-lang).
const LANG = process.env.STS2_LANG || 'eng';

// ── Logging helpers ─────────────────────────────────────────────────────────

const TS = () => new Date().toLocaleTimeString();
const log  = (msg) => console.log(`[${TS()}] ${msg}`);
const warn = (msg) => console.warn(`[${TS()}] ⚠ ${msg}`);
const ok   = (msg) => console.log(`[${TS()}] ✓ ${msg}`);
const hr   = (title) => console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}\n`);

// ── Stages ──────────────────────────────────────────────────────────────────

function stageDetect() {
  hr('STEAM / STS2 DETECTION');
  const r = detectSteam();
  if (!r.found) {
    warn('STS2 not detected.');
    if (r.errors?.length) for (const e of r.errors) warn(e);
    return null;
  }
  ok(`STS2 ${r.install.version} (build ${r.install.buildId}, branch ${r.install.branch})`);
  log(`  Install: ${r.install.installDir}`);
  log(`  PCK:     ${r.install.pckPath}  ${r.install.pckExists ? '✓' : '✗ missing'}`);
  log(`  DLL:     ${r.install.dllPath}  ${r.install.dllExists ? '✓' : '✗ missing'}`);
  return r;
}

function stageToolsStatus() {
  hr('TOOL CACHE STATUS');
  log(`Cache root: ${TOOLS_ROOT}`);
  const status = tm.detectAll();
  for (const [name, s] of Object.entries(status)) {
    if (s.installed) ok(`${s.label.padEnd(11)} — ${s.version || '?'}  (${s.executablePath})`);
    else             warn(`${s.label.padEnd(11)} — not installed`);
  }
  return status;
}

async function stageInstall(name) {
  hr(`INSTALL: ${name.toUpperCase()}`);
  log('Querying GitHub for latest release…');
  let lastPct = -1;
  try {
    const result = await tm.installTool(name, (progress) => {
      if (progress.phase === 'downloading' && progress.total) {
        const pct = Math.floor(progress.downloaded / progress.total * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          process.stdout.write(`\r  download: ${pct}%  (${(progress.downloaded / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB)`);
        }
      } else if (progress.phase === 'downloading') {
        process.stdout.write(`\r  download: ${(progress.downloaded / 1024 / 1024).toFixed(1)} MB`);
      } else if (progress.message) {
        if (lastPct >= 0) { process.stdout.write('\n'); lastPct = -1; }
        log(progress.message);
      }
    });
    if (lastPct >= 0) process.stdout.write('\n');
    ok(`${result.label} ${result.version} → ${result.executablePath}`);
    return result;
  } catch (e) {
    if (lastPct >= 0) process.stdout.write('\n');
    warn(`Install failed: ${e.message}`);
    return null;
  }
}

// Probe a tool's --help so we can see what CLI flags to use without guessing.
function stageProbe(name) {
  hr(`PROBE: ${name.toUpperCase()} --help`);
  const detected = tm.detectInstalled(name);
  if (!detected.installed) { warn('Not installed yet — run install-' + name + ' first.'); return; }
  log(`  exe: ${detected.executablePath}`);
  for (const flag of ['--help', '-h', '/?']) {
    const r = spawnSync(detected.executablePath, [flag], { encoding: 'utf8' });
    if (r.error) { warn(`spawn error for ${flag}: ${r.error.message}`); continue; }
    log(`--- ${flag} (exit ${r.status}) ---`);
    if (r.stdout) console.log(r.stdout.slice(0, 4000));
    if (r.stderr) console.log('stderr:', r.stderr.slice(0, 4000));
    if (r.status === 0 || (r.stdout && r.stdout.length > 50)) break;
  }
}

// Run GDRE Tools to extract the PCK. Best-guess CLI flags based on the
// project's README — adjust once we've probed the actual --help output.
async function stageExtractPck(steam) {
  hr('EXTRACT PCK');
  if (!steam) steam = stageDetect();
  if (!steam || !steam.found) return null;

  const detected = tm.detectInstalled('gdre');
  if (!detected.installed) { warn('GDRE Tools not installed.'); return null; }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  log(`PCK:    ${steam.install.pckPath}`);
  log(`Output: ${RAW_DIR}`);
  log(`Tool:   ${detected.executablePath}`);
  // GDRE 2.x CLI: gdre_tools.exe --headless --recover=<pck> --output=<dir>
  // Fall back to other flag styles below if the first probe rejects them.
  const args = ['--headless', `--recover=${steam.install.pckPath}`, `--output=${RAW_DIR}`];
  log(`Args:   ${args.join(' ')}`);
  const result = await tm.runTool('gdre', args, {
    cwd:    path.dirname(detected.executablePath),
    onLine: ({ kind, line }) => process.stdout.write((kind === 'stderr' ? '! ' : '  ') + line + '\n'),
  });
  log(`exit: ${result.code}`);
  return result.code === 0;
}

// Run dnSpy.Console on sts2.dll → .cs files in DECOMPILED_DIR.
async function stageDecompile(steam) {
  hr('DECOMPILE DLL');
  if (!steam) steam = stageDetect();
  if (!steam || !steam.found) return null;

  const detected = tm.detectInstalled('dnspy');
  if (!detected.installed) { warn('dnSpy Console not installed.'); return null; }

  fs.mkdirSync(DECOMPILED_DIR, { recursive: true });
  log(`DLL:    ${steam.install.dllPath}`);
  log(`Output: ${DECOMPILED_DIR}`);
  log(`Tool:   ${detected.executablePath}`);
  // dnSpy.Console.exe -o <outdir> <input.dll>
  //   --no-sln       skip .sln (we don't need it; saves a few seconds)
  //   --no-resources skip embedded-resource extraction (we only need .cs)
  // Pointing dnSpy at the DLL's own dir so it can resolve dependencies via
  // GodotSharp.dll, mscorlib.dll, etc. that sit alongside.
  const args = ['--no-sln', '-o', DECOMPILED_DIR, steam.install.dllPath];
  log(`Args:   ${args.join(' ')}`);
  const result = await tm.runTool('dnspy', args, {
    cwd:    path.dirname(steam.install.dllPath),
    onLine: ({ kind, line }) => process.stdout.write((kind === 'stderr' ? '! ' : '  ') + line + '\n'),
  });
  log(`exit: ${result.code}`);
  return result.code === 0;
}

// Run all 5 ported parsers against the decompiled output.
function stageParse() {
  hr('PARSE');
  if (!fs.existsSync(DECOMPILED_DIR)) {
    warn(`Decompiled dir doesn't exist: ${DECOMPILED_DIR}`);
    return false;
  }
  const locDir = path.join(RAW_DIR, 'localization', LANG);
  if (!fs.existsSync(locDir)) {
    warn(`Localization dir missing: ${locDir}`);
    log('  → expected GDRE to extract `localization/<lang>/` from the PCK.');
    log('  → without localization JSON the parsers will run but produce empty descriptions.');
  }
  const outDir = path.join(EXTRACTED_OUTPUT, LANG);
  fs.mkdirSync(outDir, { recursive: true });

  const parsersDir = path.join(__dirname, 'parsers');

  // GDRE writes PCK contents to `<RAW_DIR>/images/<category>/<id>.png` for
  // most entity types. Cards alone are nested by character pool under
  // `<RAW_DIR>/images/packed/card_portraits/<color>/<id>.png`; the card
  // parser knows about that layout and emits `image_file: "<color>/<id>.png"`
  // relative paths so the renderer can resolve from one root.
  const IMG = (sub) => path.join(RAW_DIR, 'images', sub);

  const results = {};
  const parserSpecs = [
    { key: 'potions',      file: 'potion_parser.js',      fn: 'parseAllPotions',      imagesDir: IMG('potions') },
    { key: 'enchantments', file: 'enchantment_parser.js', fn: 'parseAllEnchantments', imagesDir: IMG('enchantments') },
    { key: 'relics',       file: 'relic_parser.js',       fn: 'parseAllRelics',       imagesDir: IMG('relics') },
    { key: 'cards',        file: 'card_parser.js',        fn: 'parseAllCards',        imagesDir: IMG(path.join('packed', 'card_portraits')) },
    { key: 'events',       file: 'event_parser.js',       fn: 'parseAllEvents',       imagesDir: IMG('events'),
      extraOpts: { ancientImagesDir: IMG('ancients'), monsterImagesDir: IMG('monsters') } },
  ];

  for (const spec of parserSpecs) {
    log(`Running ${spec.file}…`);
    let mod;
    try { mod = require(path.join(parsersDir, spec.file)); }
    catch (e) { warn(`  failed to require ${spec.file}: ${e.message}`); continue; }
    if (typeof mod[spec.fn] !== 'function') { warn(`  ${spec.file} has no ${spec.fn}`); continue; }
    let arr;
    try {
      const callOpts = {
        decompiledRoot: DECOMPILED_DIR, locDir,
        imagesDir:      spec.imagesDir,
        ...(spec.extraOpts || {}),
      };
      if (spec.key === 'events') callOpts.relicDataPath = path.join(outDir, 'relics.json');
      arr = mod[spec.fn](callOpts);
    } catch (e) {
      warn(`  parser threw: ${e.message}`);
      if (e.stack) warn(e.stack.split('\n').slice(1, 5).join('\n'));
      continue;
    }
    if (!Array.isArray(arr)) { warn(`  ${spec.fn} did not return an array`); continue; }
    const dest = path.join(outDir, `${spec.key}.json`);
    fs.writeFileSync(dest, JSON.stringify(arr, null, 2), 'utf8');
    const withImage = arr.filter(e => e.image_file).length;
    results[spec.key] = `${arr.length} (${withImage} with images)`;
    ok(`  ${spec.key}: ${arr.length} entries, ${withImage} with images → ${dest}`);
  }
  hr('SUMMARY');
  console.log(JSON.stringify(results, null, 2));
  return Object.keys(results).length > 0;
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  // Default = run the whole pipeline. Pass an explicit stage to scope to
  // just that step (e.g. for debugging or re-runs).
  const stage = process.argv[2] || 'all';

  switch (stage) {
    case 'detect':         stageDetect();              break;
    case 'tools':          stageToolsStatus();         break;
    case 'install-gdre':   await stageInstall('gdre');  break;
    case 'install-dnspy':  await stageInstall('dnspy'); break;
    case 'install-tools':  await stageInstall('gdre'); await stageInstall('dnspy'); break;
    case 'probe-gdre':     stageProbe('gdre');         break;
    case 'probe-dnspy':    stageProbe('dnspy');        break;
    case 'extract-pck':    await stageExtractPck();    break;
    case 'decompile':      await stageDecompile();     break;
    case 'parse':          stageParse();               break;

    case 'all': {
      const steam = stageDetect();
      if (!steam || !steam.found) { warn('Stopping — STS2 install required.'); break; }
      const status = stageToolsStatus();
      if (!status.gdre.installed)  await stageInstall('gdre');
      if (!status.dnspy.installed) await stageInstall('dnspy');
      const pckOk = await stageExtractPck(steam);
      if (!pckOk) { warn('Stopping — PCK extraction failed.'); break; }
      const dllOk = await stageDecompile(steam);
      if (!dllOk) { warn('Stopping — DLL decompile failed.'); break; }
      stageParse();
      break;
    }

    case 'help':
    default:
      console.log('Usage: node scripts/run_extraction.js [stage]');
      console.log('  (no stage)       run the whole pipeline ("all")');
      console.log('  detect           Steam + STS2 install detection');
      console.log('  tools            Show installed tool status');
      console.log('  install-gdre     Download + extract GDRE Tools');
      console.log('  install-dnspy    Download + extract dnSpy Console');
      console.log('  install-tools    install-gdre + install-dnspy');
      console.log('  probe-gdre       Print gdre_tools --help');
      console.log('  probe-dnspy      Print dnSpy.Console --help');
      console.log('  extract-pck      GDRE → raw/');
      console.log('  decompile        dnSpy → decompiled/');
      console.log('  parse            JS parsers → data-extracted/<lang>/');
      console.log('  all              full pipeline');
      break;
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
