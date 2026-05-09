'use strict';
/**
 * snapshot_basis.js — Capture the dashboard's current simplified data as a
 * "basis" snapshot for the kernel editor.
 *
 * The basis is the starting state from which the editor forward-composes
 * older state via finalized kernels. When a new patch lands and the user
 * authors the kernel for it, the editor pre-fills each entity's `old`
 * field values from `compose(basis, finalized_kernels_newer_than_basis_up_to_kernel.to)`.
 *
 * Usage:  npm run snapshot
 *
 * Reads:
 *   <userData>/sts2-dashboard/Assets/data/{cards,relics,enchantments}.json
 *   <repo>/Release Version/data/manifest.json   (for current_version)
 *
 * Writes:
 *   <repo>/kernel-editor/basis/cards.json
 *   <repo>/kernel-editor/basis/relics.json
 *   <repo>/kernel-editor/basis/enchantments.json
 *   <repo>/kernel-editor/basis/basis-info.json   { version, snapshot_date, source }
 */

const fs   = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const BASIS_DIR  = path.join(SCRIPT_DIR, '..', 'basis');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '.', '.config');
const DASHBOARD_DATA  = path.join(APPDATA, 'sts2-dashboard', 'Assets', 'data');
const RESOURCE_META   = path.join(APPDATA, 'sts2-dashboard', 'Assets', 'settings', 'resource_meta.json');
const MANIFEST_PATH   = path.resolve(SCRIPT_DIR, '..', 'manifest.json');

const CATEGORIES = ['cards', 'relics', 'enchantments'];

function main() {
  if (!fs.existsSync(DASHBOARD_DATA)) {
    console.error(`Dashboard data dir not found: ${DASHBOARD_DATA}`);
    console.error("Run the dashboard's Update Resources at least once first.");
    process.exit(1);
  }
  // Prefer the dashboard's saved game version (the version of the actual
  // PCK that was extracted). Fall back to the wiki manifest's current_version
  // with a warning — those can disagree if the wiki has newer patch notes
  // than the user's installed game.
  let version = null;
  let versionSource = '';
  if (fs.existsSync(RESOURCE_META)) {
    try {
      const meta = JSON.parse(fs.readFileSync(RESOURCE_META, 'utf8'));
      if (meta && meta.gameVersion) {
        version = meta.gameVersion;
        versionSource = 'dashboard resource_meta.json';
      }
    } catch (_) {}
  }
  if (!version) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      console.error(`Neither dashboard resource_meta.json nor manifest.json found.`);
      console.error(`  resource_meta: ${RESOURCE_META}`);
      console.error(`  manifest:      ${MANIFEST_PATH}`);
      console.error('Run the dashboard\'s Update Resources at least once first.');
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    version = manifest.current_version;
    versionSource = 'wiki manifest current_version';
    console.warn(`(warning) dashboard resource_meta.json missing or has no gameVersion field —`);
    console.warn(`           falling back to manifest's current_version (${version}).`);
    console.warn(`           If this version disagrees with what's actually installed, the basis`);
    console.warn(`           label will be wrong. Re-run the dashboard's Update Resources to fix.`);
  }
  if (!version) {
    console.error('Could not determine basis version.');
    process.exit(1);
  }

  fs.mkdirSync(BASIS_DIR, { recursive: true });
  const counts = {};
  for (const cat of CATEGORIES) {
    const src = path.join(DASHBOARD_DATA, `${cat}.json`);
    if (!fs.existsSync(src)) {
      console.warn(`(skipping ${cat}: ${src} not present)`);
      counts[cat] = 0;
      continue;
    }
    const dst = path.join(BASIS_DIR, `${cat}.json`);
    fs.copyFileSync(src, dst);
    const arr = JSON.parse(fs.readFileSync(dst, 'utf8'));
    counts[cat] = Array.isArray(arr) ? arr.length : 0;
  }

  const info = {
    version,
    versionSource,
    snapshot_date: new Date().toISOString(),
    source:        DASHBOARD_DATA,
    counts,
  };
  fs.writeFileSync(path.join(BASIS_DIR, 'basis-info.json'), JSON.stringify(info, null, 2), 'utf8');

  console.log(`Basis snapshot written to ${BASIS_DIR}`);
  console.log(`  version: ${version}  (source: ${versionSource})`);
  console.log(`  counts:  ${JSON.stringify(counts)}`);
}

main();
