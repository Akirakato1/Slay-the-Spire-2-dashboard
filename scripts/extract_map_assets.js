'use strict';
/**
 * Main-process module: extract every map-related image asset (room-type
 * icons, ancients, boss icons, act backdrops) from the user's STS2 PCK
 * into a stable output dir under appdata.
 *
 * This is Electron-only — it uses `nativeImage` to slice atlas regions
 * for the room-type icons (which ship as Rect2 references into ui_atlas_*.png
 * rather than standalone PNGs). For that reason, prefer calling this via
 * the `extract-map-assets` IPC handler rather than `node script.js`.
 *
 * Usage from main.js:
 *   const { extractMapAssets } = require('./scripts/extract_map_assets.js');
 *   const result = await extractMapAssets({
 *     pckPath, gdreExe, outputDir,
 *     onProgress: ({ phase, message }) => { ... },
 *   });
 *
 * Output layout under `outputDir`:
 *   map_icons/
 *     map_monster.png, map_elite.png, map_chest.png, ...   (atlas-cropped)
 *     ancient_node_neow.png, ancient_node_pael.png, ...    (raw PNGs)
 *     vantom_boss_icon.png, kaiser_crab_boss_icon.png, ... (raw PNGs)
 *   map_backdrops/
 *     overgrowth/{map_top,map_middle,map_bottom}_overgrowth.png
 *     hive/...  glory/...  underdocks/...
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawn } = require('child_process');
const { nativeImage } = require('electron');

// Patterns we copy verbatim from the GDRE staging tree.
const RAW_KEEP = [
  /^ancient_node_[a-z0-9_]+\.png$/i,
  /^[a-z0-9_]+_boss_icon\.png$/i,
];
// Atlas-cropped icons: .tres files we slice into individual PNGs.
const ATLAS_KEEP = [
  /^map_(monster|burly_monster|elite|chest|chest_boss|rest|shop|unknown|unknown_chest|unknown_elite|unknown_monster|unknown_shop|node_background)\.tres$/i,
];

// Spine atlas-only bosses: ship as a libgdx .atlas + sprite-sheet PNG (multi-
// part for skeletal animation). We pick the largest non-backdrop region and
// crop it as the static icon. Map: <atlas filename> → <output icon filename>.
const SPINE_BOSS_ATLASES = {
  'ceremonial_beast_boss_node.atlas': 'ceremonial_beast_boss_icon.png',
  'queen_boss_node.atlas':            'false_queen_boss_icon.png',
  'the_insatiable_boss_node.atlas':   'the_insatiable_boss_icon.png',
};

// Region names to ignore when picking the "main" sprite — these are usually
// background plates or visual-effect overlays, not the boss silhouette.
const SPINE_REGION_SKIP = /^(backdrop|bg|background|shadow|vignette|light|glow|particle|shine|aura|fog|smoke|dust|spark)$/i;

// Hand-tuned overrides for atlases where the largest-area heuristic picks the
// wrong region. Each entry is either:
//   { region: 'name' }                              — slice that region only
//   { canvas: {w, h}, parts: [{region, x, y, rotation, rotate180}, ...] }
//                                                   — composite at offsets
//
// `parts` are drawn back-to-front (later = on top). `x, y` is the top-left
// placement of the (un-rotated, display-oriented) part on the canvas.
// `rotation` (degrees) rotates the part around its center; `rotate180` is
// shorthand kept for back-compat with hand-edited entries.
//
// Specs saved by `compose_tool/` (an Electron tool that lets you drag/rotate
// regions visually) override anything in this map. The compose-tool spec
// shape is { atlas, canvas, parts:[{region, x, y, rotation}] }.
const SPINE_BOSS_OVERRIDES = {};

// Load any composer-tool-saved specs once at module load. Specs live inside
// the dashboard source tree (Release Version/scripts/spine_specs/) so they
// get bundled into the packaged exe via electron-builder. The compose_tool
// itself sits at <repo-root>/compose_tool/ (a dev-only utility, not part of
// the app), but writes its output here so the dashboard picks it up.
const _COMPOSER_SPECS_DIR = path.resolve(__dirname, 'spine_specs');
(function _loadComposerSpecs() {
  try {
    if (!fs.existsSync(_COMPOSER_SPECS_DIR)) return;
    for (const f of fs.readdirSync(_COMPOSER_SPECS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const spec = JSON.parse(fs.readFileSync(path.join(_COMPOSER_SPECS_DIR, f), 'utf8'));
        if (spec?.canvas && Array.isArray(spec?.parts)) {
          SPINE_BOSS_OVERRIDES[f.replace(/\.json$/, '')] = spec;
        }
      } catch (_) { /* ignore malformed */ }
    }
  } catch (_) {}
})();

// Strict GDRE include globs covering everything we need.
const GDRE_INCLUDES = [
  '**/ancient_node_*.png',
  '**/*_boss_icon.png',
  '**/boss_node_*.png',
  '**/*_boss_node.atlas',
  '**/ui_atlas.sprites/map/icons/map_*.tres',
  '**/map_bgs/**/*.png',
  '**/.godot/imported/ancient_node_*',
  '**/.godot/imported/*_boss_icon*',
  '**/.godot/imported/boss_node_*',
  '**/.godot/imported/*_boss_node.atlas*',
  '**/.godot/imported/ui_atlas_*',
  '**/.godot/imported/map_top_*',
  '**/.godot/imported/map_middle_*',
  '**/.godot/imported/map_bottom_*',
];

// GDRE include globs that the *standalone* extractor needs. The main update
// pipeline already extracts a superset of these (see main.js's includeGlobs);
// the pipeline path uses processStagedMapAssets() against rawDir without a
// second GDRE run.
const PIPELINE_INCLUDES_HINT = [
  // Add these to main.js's includeGlobs so the pipeline pulls them too:
  //   images/packed/map/**            (ancients + map_bgs)
  //   images/map/placeholder/**       (boss placeholder icons)
  //   images/atlases/ui_atlas_*.png   (atlas image data)
  //   images/atlases/ui_atlas.sprites/map/**  (atlas references)
];

/**
 * Process a directory tree that already contains GDRE-recovered map assets
 * (e.g. the pipeline's rawDir). Slices atlas regions, copies raw PNGs, and
 * copies backdrops into outputDir/{map_icons, map_backdrops}/.
 *
 * @param {object}   args
 * @param {string}   args.stagingDir  GDRE recovery root
 * @param {string}   args.outputDir   where to write map_icons/ and map_backdrops/
 * @param {function} [args.onProgress]  ({phase, message}) callback
 * @returns {{ icons:string[], backdrops:string[], skipped:string[] }}
 */
function processStagedMapAssets({ stagingDir, outputDir, onProgress }) {
  const log = (phase, message) => onProgress && onProgress({ phase, message });

  const iconsOutDir = path.join(outputDir, 'map_icons');
  const bdsOutDir   = path.join(outputDir, 'map_backdrops');
  fs.mkdirSync(iconsOutDir, { recursive: true });
  fs.mkdirSync(bdsOutDir,   { recursive: true });

  // 1. Copy raw PNGs (ancients + boss placeholders).
  log('map-copy-raw', 'Copying ancient + boss icons…');
  const rawIcons = walkFiles(stagingDir, (name) => RAW_KEEP.some((re) => re.test(name)));
  const writtenIcons = [];
  for (const src of rawIcons) {
    const dst = path.join(iconsOutDir, path.basename(src));
    fs.copyFileSync(src, dst);
    writtenIcons.push(path.basename(dst));
  }

  // 2. Slice atlas regions for the room-type icons.
  log('map-atlas', 'Slicing room-type icons from ui_atlas…');
  const tresFiles = walkFiles(stagingDir, (name) => ATLAS_KEEP.some((re) => re.test(name)));
  const skipped = [];
  for (const tresPath of tresFiles) {
    try {
      const sliced = sliceAtlasTres(tresPath, stagingDir, iconsOutDir);
      if (sliced) writtenIcons.push(sliced);
    } catch (e) {
      skipped.push(`${path.basename(tresPath)}: ${e.message}`);
      log('map-atlas-warn', `${path.basename(tresPath)}: ${e.message}`);
    }
  }

  // 3. Slice Spine-atlas-only bosses (Ceremonial Beast, False Queen, The
  // Insatiable). Pick the largest non-backdrop region and crop+rotate into a
  // standalone <name>_boss_icon.png alongside the placeholder boss icons.
  log('map-spine', 'Slicing Spine-atlas boss icons…');
  for (const [atlasName, outName] of Object.entries(SPINE_BOSS_ATLASES)) {
    const atlasPath = walkFiles(stagingDir, (n) => n === atlasName)[0];
    if (!atlasPath) continue;
    try {
      const sliced = sliceSpineBossIcon(atlasPath, path.join(iconsOutDir, outName));
      if (sliced) writtenIcons.push(outName);
    } catch (e) {
      skipped.push(`${atlasName}: ${e.message}`);
      log('map-spine-warn', `${atlasName}: ${e.message}`);
    }
  }

  // 4. Copy backdrops, preserving the per-act folder layout.
  log('map-copy-backdrops', 'Copying act backdrops…');
  const bdRoot = findFirstDir(stagingDir, 'map_bgs');
  const writtenBds = [];
  if (bdRoot) {
    for (const actFolder of fs.readdirSync(bdRoot)) {
      const srcDir = path.join(bdRoot, actFolder);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(bdsOutDir, actFolder);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        if (!/\.png$/i.test(f) || /\.import$/i.test(f)) continue;
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
        writtenBds.push(`${actFolder}/${f}`);
      }
    }
  }

  log('map-done', `Extracted ${writtenIcons.length} icons + ${writtenBds.length} backdrops`);
  return { icons: writtenIcons.sort(), backdrops: writtenBds.sort(), skipped };
}

/**
 * One-shot extractor: spawns its own GDRE, runs processStagedMapAssets, then
 * cleans up the staging dir. Used by the standalone `extract-map-assets` IPC
 * for users who want to refresh map assets without re-running the full
 * resource-update pipeline.
 *
 * @param {object}   args
 * @param {string}   args.pckPath     absolute path to SlayTheSpire2.pck
 * @param {string}   args.gdreExe     absolute path to gdre_tools.exe
 * @param {string}   args.outputDir   where to write map_icons/ and map_backdrops/
 * @param {function} [args.onProgress]  ({phase, message}) callback
 * @returns {Promise<{ icons:string[], backdrops:string[], skipped:string[] }>}
 */
async function extractMapAssets({ pckPath, gdreExe, outputDir, onProgress }) {
  const log = (phase, message) => onProgress && onProgress({ phase, message });
  if (!fs.existsSync(pckPath))  throw new Error(`PCK not found: ${pckPath}`);
  if (!fs.existsSync(gdreExe))  throw new Error(`GDRE exe not found: ${gdreExe}`);

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts2-mapassets-'));
  try {
    log('gdre', `Extracting from ${path.basename(pckPath)}…`);
    await runGdre(gdreExe, pckPath, stagingDir);
    return processStagedMapAssets({ stagingDir, outputDir, onProgress });
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── GDRE invocation ─────────────────────────────────────────────────────────

function runGdre(gdreExe, pckPath, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless',
      `--recover=${pckPath}`,
      `--output=${outputDir}`,
      ...GDRE_INCLUDES.map((g) => `--include=${g}`),
      '--ignore-checksum-errors',
    ];
    const p = spawn(gdreExe, args, { cwd: path.dirname(gdreExe), stdio: 'pipe' });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`GDRE exited ${code}: ${stderr.slice(0, 500)}`));
    });
    p.on('error', reject);
  });
}

// ── .tres parsing + atlas cropping ──────────────────────────────────────────

// Parse a Godot AtlasTexture .tres file. Returns { atlasPath, region }.
//   atlasPath: relative path of the source atlas (e.g. "images/atlases/ui_atlas_0.png")
//   region:    { x, y, width, height }
function parseTres(text) {
  const atlasMatch  = text.match(/path="res:\/\/(images\/atlases\/[^"]+\.png)"/);
  const regionMatch = text.match(/region\s*=\s*Rect2\(([^)]+)\)/);
  if (!atlasMatch || !regionMatch) return null;
  const [x, y, w, h] = regionMatch[1].split(',').map((s) => parseFloat(s.trim()));
  return {
    atlasPath: atlasMatch[1],
    region:    { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) },
  };
}

// ── Spine atlas slicing ─────────────────────────────────────────────────────

// Parse a libgdx-format Spine atlas. Returns
//   { png: 'boss_node_x.png', regions: [{name, x, y, w, h, rotate}] }
// where `rotate` is true if the source region was packed 90° CW into the
// atlas (so the cropped pixels need a 90° CCW rotation to display upright).
function parseSpineAtlas(text) {
  const lines = text.split(/\r?\n/);
  // First non-empty line is the page PNG filename.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const pngName = (lines[i] || '').trim();
  i++;                            // step PAST the page-name line so it's not parsed as a region

  // Skip the page header (size:, filter:, scale:, etc.) until the first
  // region. Region entries don't contain ':' on their name line.
  const regions = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    // A name line starts at column 0 with no colon and no leading whitespace.
    if (raw.length && raw[0] !== ' ' && raw[0] !== '\t' && !raw.includes(':')) {
      if (cur) regions.push(cur);
      cur = { name: raw.trim(), x: 0, y: 0, w: 0, h: 0, rotate: false };
      continue;
    }
    if (!cur) continue;            // still in header
    const m = raw.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'bounds') {
      const [x, y, w, h] = val.split(',').map((s) => parseInt(s.trim(), 10));
      cur.x = x; cur.y = y; cur.w = w; cur.h = h;
    } else if (key === 'xy') {
      const [x, y] = val.split(',').map((s) => parseInt(s.trim(), 10));
      cur.x = x; cur.y = y;
    } else if (key === 'size') {
      const [w, h] = val.split(',').map((s) => parseInt(s.trim(), 10));
      cur.w = w; cur.h = h;
    } else if (key === 'rotate') {
      cur.rotate = (val === 'true' || val === '90');
    }
  }
  if (cur) regions.push(cur);
  return { png: pngName, regions };
}

// Rotate an RGBA bitmap 90° CCW. Used to undo the libgdx atlas's CW packing
// so the displayed icon faces upright.
function rotateBitmap90CCW(buf, srcW, srcH) {
  const dstW = srcH, dstH = srcW;
  const out  = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const srcIdx = (y * srcW + x) * 4;
      const dstX   = y;
      const dstY   = srcW - 1 - x;
      const dstIdx = (dstY * dstW + dstX) * 4;
      out[dstIdx]     = buf[srcIdx];
      out[dstIdx + 1] = buf[srcIdx + 1];
      out[dstIdx + 2] = buf[srcIdx + 2];
      out[dstIdx + 3] = buf[srcIdx + 3];
    }
  }
  return { buffer: out, width: dstW, height: dstH };
}

// Extract a single region from the atlas as a NativeImage, applying the
// libgdx 90° CW packing reversal. Returns { img, w, h } where w/h are the
// display (un-rotated) dimensions.
function extractSpineRegion(atlasImg, region) {
  // bounds w/h are display-orientation dims; atlas-occupied is swapped if rotated.
  const atlasW = region.rotate ? region.h : region.w;
  const atlasH = region.rotate ? region.w : region.h;
  const cropped = atlasImg.crop({ x: region.x, y: region.y, width: atlasW, height: atlasH });
  if (cropped.isEmpty()) throw new Error(`crop returned empty for region "${region.name}"`);
  if (!region.rotate) {
    return { img: cropped, w: region.w, h: region.h };
  }
  const bmp = cropped.toBitmap();             // BGRA on Windows
  const rot = rotateBitmap90CCW(bmp, atlasW, atlasH);
  const img = nativeImage.createFromBuffer(rot.buffer, { width: rot.width, height: rot.height });
  return { img, w: rot.width, h: rot.height };
}

// Rotate an RGBA bitmap 180° in place-style (returns new buffer of same dims).
function rotateBitmap180(buf, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sIdx = (y * w + x) * 4;
      const dx = w - 1 - x, dy = h - 1 - y;
      const dIdx = (dy * w + dx) * 4;
      out[dIdx]     = buf[sIdx];
      out[dIdx + 1] = buf[sIdx + 1];
      out[dIdx + 2] = buf[sIdx + 2];
      out[dIdx + 3] = buf[sIdx + 3];
    }
  }
  return out;
}

// Rotate an RGBA bitmap 90° CW. Returns { buffer, width, height } where the
// new dimensions are swapped from the input.
function rotateBitmap90CW(buf, srcW, srcH) {
  const dstW = srcH, dstH = srcW;
  const out  = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const sIdx = (y * srcW + x) * 4;
      const dx = srcH - 1 - y, dy = x;
      const dIdx = (dy * dstW + dx) * 4;
      out[dIdx]     = buf[sIdx];
      out[dIdx + 1] = buf[sIdx + 1];
      out[dIdx + 2] = buf[sIdx + 2];
      out[dIdx + 3] = buf[sIdx + 3];
    }
  }
  return { buffer: out, width: dstW, height: dstH };
}

// Apply a quarter-turn rotation to (bmp, w, h) and return { bmp, w, h } with
// possibly-swapped dimensions. `deg` is snapped to the nearest 90° multiple
// — main-process bitmap rotation only works exactly at right angles.
function applyQuarterRotation(bmp, w, h, deg) {
  const norm = ((Math.round((deg || 0) / 90) * 90) % 360 + 360) % 360;
  if (norm === 0)   return { bmp, w, h };
  if (norm === 90)  { const r = rotateBitmap90CW(bmp, w, h);          return { bmp: r.buffer, w: r.width, h: r.height }; }
  if (norm === 180) {                                                 return { bmp: rotateBitmap180(bmp, w, h), w, h }; }
  if (norm === 270) { const r = rotateBitmap90CCW(bmp, w, h);         return { bmp: r.buffer, w: r.width, h: r.height }; }
  return { bmp, w, h };
}

// Composite a list of {region, x, y[, rotation|rotate180]} onto a transparent
// canvas. Parts are drawn back-to-front. Source-over alpha blending. Each
// part's rotation snaps to the nearest 90° multiple.
function compositeSpineParts(atlasImg, atlasInfo, canvas, parts) {
  const out = Buffer.alloc(canvas.w * canvas.h * 4);   // RGBA, all-zero = transparent
  for (const part of parts) {
    const region = atlasInfo.regions.find((r) => r.name === part.region);
    if (!region) throw new Error(`region not found: "${part.region}"`);
    const ext = extractSpineRegion(atlasImg, region);
    const deg = part.rotation != null ? part.rotation : (part.rotate180 ? 180 : 0);
    const rot = applyQuarterRotation(ext.img.toBitmap(), ext.w, ext.h, deg);
    blitBGRAOverRGBA(rot.bmp, rot.w, rot.h, out, canvas.w, canvas.h, part.x | 0, part.y | 0);
  }
  return nativeImage.createFromBuffer(out, { width: canvas.w, height: canvas.h });
}

// Convert a BGRA bitmap to an RGBA bitmap where every opaque pixel becomes
// opaque white. Matches the placeholder *_boss_icon.png style (white
// silhouette on transparent) so all boss icons render consistently.
function toWhiteSilhouette(bgra, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = bgra[i + 3];
    if (a === 0) continue;       // transparent — leave the destination zeroed
    out[i]     = 255;             // R
    out[i + 1] = 255;             // G
    out[i + 2] = 255;             // B
    out[i + 3] = a;               // preserve alpha (incl. anti-aliased edges)
  }
  return out;
}

// Source-over blit: copy a BGRA source bitmap onto an RGBA destination
// buffer at (dstX, dstY). Skips pixels outside the canvas.
function blitBGRAOverRGBA(src, srcW, srcH, dst, dstW, dstH, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    const dy = dstY + y;
    if (dy < 0 || dy >= dstH) continue;
    for (let x = 0; x < srcW; x++) {
      const dx = dstX + x;
      if (dx < 0 || dx >= dstW) continue;
      const sIdx = (y * srcW + x) * 4;
      const sa = src[sIdx + 3];
      if (sa === 0) continue;
      const dIdx = (dy * dstW + dx) * 4;
      const da = dst[dIdx + 3];
      if (da === 0) {
        // Fast path: dst is transparent, just copy (swapping BGRA→RGBA).
        dst[dIdx + 0] = src[sIdx + 2];
        dst[dIdx + 1] = src[sIdx + 1];
        dst[dIdx + 2] = src[sIdx + 0];
        dst[dIdx + 3] = sa;
        continue;
      }
      // Source-over compositing with straight alpha.
      const sA = sa / 255, dA = da / 255;
      const oA = sA + dA * (1 - sA);
      if (oA <= 0) continue;
      const inv = (1 - sA);
      dst[dIdx + 0] = Math.round((src[sIdx + 2] * sA + dst[dIdx + 0] * dA * inv) / oA);
      dst[dIdx + 1] = Math.round((src[sIdx + 1] * sA + dst[dIdx + 1] * dA * inv) / oA);
      dst[dIdx + 2] = Math.round((src[sIdx + 0] * sA + dst[dIdx + 2] * dA * inv) / oA);
      dst[dIdx + 3] = Math.round(oA * 255);
    }
  }
}

// Crop the right region (or composite of regions) from the atlas's PNG and
// write it. Uses SPINE_BOSS_OVERRIDES if the atlas is in there; otherwise
// falls back to the largest-non-backdrop heuristic.
function sliceSpineBossIcon(atlasPath, outPath) {
  const text = fs.readFileSync(atlasPath, 'utf8');
  const atlas = parseSpineAtlas(text);
  if (!atlas.png || !atlas.regions.length) throw new Error('atlas parse failed');

  const pngFull = path.join(path.dirname(atlasPath), atlas.png);
  if (!fs.existsSync(pngFull)) throw new Error(`atlas PNG missing: ${atlas.png}`);
  const atlasImg = nativeImage.createFromPath(pngFull);
  if (atlasImg.isEmpty()) throw new Error('nativeImage failed to load atlas PNG');

  const override = SPINE_BOSS_OVERRIDES[path.basename(atlasPath)];
  let outBytes;

  if (override?.parts && override.canvas) {
    const composite = compositeSpineParts(atlasImg, atlas, override.canvas, override.parts);
    // Convert to white silhouette so the result matches the placeholder
    // *_boss_icon.png style (every opaque pixel becomes opaque white).
    const whiteBmp = toWhiteSilhouette(composite.toBitmap(), override.canvas.w, override.canvas.h);
    outBytes = nativeImage.createFromBuffer(whiteBmp, {
      width:  override.canvas.w,
      height: override.canvas.h,
    }).toPNG();
  } else if (override?.region) {
    const region = atlas.regions.find((r) => r.name === override.region);
    if (!region) throw new Error(`override region not found: "${override.region}"`);
    const { img } = extractSpineRegion(atlasImg, region);
    outBytes = img.toPNG();
  } else {
    // Heuristic fallback.
    const candidates = atlas.regions.filter((r) => !SPINE_REGION_SKIP.test(r.name));
    if (!candidates.length) throw new Error('no usable regions');
    candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const { img } = extractSpineRegion(atlasImg, candidates[0]);
    outBytes = img.toPNG();
  }

  fs.writeFileSync(outPath, outBytes);
  return true;
}

function sliceAtlasTres(tresPath, stagingDir, iconsOutDir) {
  const ref = parseTres(fs.readFileSync(tresPath, 'utf8'));
  if (!ref) return null;

  const atlasFull = path.join(stagingDir, ref.atlasPath);
  if (!fs.existsSync(atlasFull)) {
    throw new Error(`atlas missing: ${ref.atlasPath}`);
  }
  const img = nativeImage.createFromPath(atlasFull);
  if (img.isEmpty()) throw new Error(`nativeImage failed to load atlas`);
  const cropped = img.crop(ref.region);
  if (cropped.isEmpty()) throw new Error(`crop returned empty (region out of bounds?)`);

  const baseName = path.basename(tresPath, '.tres') + '.png';
  fs.writeFileSync(path.join(iconsOutDir, baseName), cropped.toPNG());
  return baseName;
}

// ── Filesystem walking helpers ──────────────────────────────────────────────

function walkFiles(root, predicate) {
  const out = [];
  function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.isFile() && predicate(e.name)) out.push(full);
    }
  }
  rec(root);
  return out;
}

function findFirstDir(root, name) {
  let found = null;
  function rec(dir) {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (found) return;
      if (e.isDirectory()) {
        if (e.name === name) { found = path.join(dir, e.name); return; }
        rec(path.join(dir, e.name));
      }
    }
  }
  rec(root);
  return found;
}

module.exports = {
  extractMapAssets, processStagedMapAssets,
  // Test hook — slice a single Spine atlas to a chosen output PNG path.
  // Used by the `slice-spine-boss-test` IPC for iterating on overrides.
  _testSliceSpineBoss: sliceSpineBossIcon,
};
