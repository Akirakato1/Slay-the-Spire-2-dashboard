'use strict';
/**
 * CLI: read a .run file → write one SVG per act next to it.
 *
 *   node "Release Version/scripts/render_map.js" path/to/file.run
 *
 * Outputs `<runfile>_act1.svg`, `_act2.svg`, ... in the same directory.
 */

const fs   = require('fs');
const path = require('path');
const { renderRun } = require('./mapgen/index.js');

// The decompiled DLL we ported from. Runs from earlier builds may use a
// slightly different map-gen algorithm and won't align exactly.
const PORTED_FROM_BUILD = 'v0.103.2';

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node render_map.js <path-to-.run>');
    process.exit(1);
  }
  const runPath = path.resolve(arg);
  if (!fs.existsSync(runPath)) {
    console.error(`Not found: ${runPath}`);
    process.exit(1);
  }
  const runData = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  console.log(`Run: ${runPath}`);
  console.log(`  seed=${runData.seed}  ascension=${runData.ascension}  acts=${(runData.acts||[]).length}  build=${runData.build_id || '?'}`);
  if (runData.build_id && runData.build_id !== PORTED_FROM_BUILD) {
    console.log(`  ⚠ run is from build ${runData.build_id}, generator is from ${PORTED_FROM_BUILD} — alignment may fail if the algorithm changed between versions`);
  }

  const results = renderRun(runData);
  const baseDir  = path.dirname(runPath);
  const baseName = path.basename(runPath, path.extname(runPath));

  for (const r of results) {
    const out = path.join(baseDir, `${baseName}_act${r.actIndex + 1}.svg`);
    fs.writeFileSync(out, r.svg, 'utf8');
    const al = r.alignment;
    const status = al.ok
      ? `${al.path.length} nodes${al.ambiguous ? '  (AMBIGUOUS)' : ''}`
      : `FAILED — ${al.reason}`;
    const boss = r.bossModelIds?.length ? `  boss: ${r.bossModelIds.join(' + ')}` : '';
    const anc  = r.ancientModelId ? `  ancient: ${r.ancientModelId}` : '';
    console.log(`  ${r.actId.padEnd(18)} → ${path.basename(out)}   path: ${status}${boss}${anc}`);
  }
}

main();
