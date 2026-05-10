'use strict';
/**
 * Decompile sts2.dll to a persistent location outside the dashboard's
 * tools cache (which the auto-updater wipes). Reuses the existing
 * tool_manager + steam_detect modules — only the output dir differs.
 *
 *   node scripts/extract_decompiled.js
 *
 * Output: <repo-root>/sts2_decompiled/  (sibling of "Release Version")
 */

const fs   = require('fs');
const path = require('path');

const tm   = require('../src/tools/tool_manager.js');
const { detect: detectSteam } = require('../src/tools/steam_detect.js');

// Parent of "Release Version" — the user's repo root.
const OUT_DIR = path.resolve(__dirname, '..', '..', 'sts2_decompiled');

const TS  = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${TS()}] ${m}`);
const ok  = (m) => console.log(`[${TS()}] ✓ ${m}`);
const err = (m) => console.error(`[${TS()}] ✗ ${m}`);

async function main() {
  const steam = detectSteam();
  if (!steam.found || !steam.install.dllExists) {
    err('STS2 install / sts2.dll not found.');
    if (steam.errors) for (const e of steam.errors) err('  ' + e);
    process.exit(1);
  }
  ok(`STS2 ${steam.install.version}  build ${steam.install.buildId}`);
  log(`  DLL: ${steam.install.dllPath}`);

  let dnspy = tm.detectInstalled('dnspy');
  if (!dnspy.installed) {
    log('dnSpy Console not in cache — installing…');
    let lastPct = -1;
    await tm.installTool('dnspy', (p) => {
      if (p.phase === 'downloading' && p.total) {
        const pct = Math.floor(p.downloaded / p.total * 100);
        if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r  download: ${pct}%`); }
      } else if (p.message) {
        if (lastPct >= 0) { process.stdout.write('\n'); lastPct = -1; }
        log('  ' + p.message);
      }
    });
    if (lastPct >= 0) process.stdout.write('\n');
    dnspy = tm.detectInstalled('dnspy');
  }
  if (!dnspy.installed) { err('dnSpy install failed.'); process.exit(1); }
  ok(`dnSpy ${dnspy.version || '?'}  ${dnspy.executablePath}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`Output: ${OUT_DIR}`);

  // dnSpy.Console.exe --no-sln -o <outdir> <input.dll>
  const args = ['--no-sln', '-o', OUT_DIR, steam.install.dllPath];
  log(`Args: ${args.join(' ')}`);

  const result = await tm.runTool('dnspy', args, {
    cwd:    path.dirname(steam.install.dllPath),
    onLine: ({ kind, line }) => process.stdout.write((kind === 'stderr' ? '! ' : '  ') + line + '\n'),
  });
  if (result.code !== 0) { err(`dnSpy exited ${result.code}`); process.exit(result.code); }
  ok(`Decompiled into ${OUT_DIR}`);

  const topLevel = fs.readdirSync(OUT_DIR);
  log(`Top-level entries: ${topLevel.length}`);
  if (topLevel.length) log('  ' + topLevel.slice(0, 12).join(', ') + (topLevel.length > 12 ? ', …' : ''));
}

main().catch(e => { err(e.stack || e.message); process.exit(1); });
