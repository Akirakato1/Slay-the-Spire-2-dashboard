'use strict';
/**
 * Render an act map as a self-contained SVG string with the user's path
 * overlaid. PNG icons + parchment backdrops are inlined as data URIs so the
 * output SVG is portable.
 *
 * Asset locations:
 *   - Default reads from <userData>/Assets/images/{map_icons, map_backdrops}/
 *     where userData = the same dir Electron's app.getPath('userData') returns.
 *   - Caller can override via opts.iconsDir / opts.backdropsDir (used by
 *     main.js to keep paths explicit, and by tests to point at fixtures).
 *
 * The expected files are populated by `scripts/extract_map_assets.js`, which
 * extracts them from the user's STS2 PCK at runtime.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { MapPointType } = require('./map_point.js');
const { getAllMapPoints } = require('./generator.js');

const COL_W   = 50;
const ROW_H   = 80;
const X_PAD   = 60;
const Y_PAD   = 60;
const NODE_SZ = 30;          // 10% smaller again
const RING_R  = 16;

// ── Default appdata paths ───────────────────────────────────────────────────

let _electronApp = null;
try { _electronApp = require('electron').app; } catch (_) {}

function _userDataPath() {
  if (_electronApp) return _electronApp.getPath('userData');
  // Standalone fallback — match Electron's default for app name "sts2-dashboard".
  const APP_NAME = 'sts2-dashboard';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

const ICONS_DIR_DEFAULT     = path.join(_userDataPath(), 'Assets', 'images', 'map_icons');
const BACKDROPS_DIR_DEFAULT = path.join(_userDataPath(), 'Assets', 'images', 'map_backdrops');

// ── Per-type icon defaults ──────────────────────────────────────────────────
// Filenames match what `extract_map_assets.js` writes. Boss / Ancient resolve
// dynamically by model_id below.

const ICON_FILES = {
  [MapPointType.Monster]:  'map_monster.png',
  [MapPointType.Elite]:    'map_elite.png',
  [MapPointType.Boss]:     null,                         // no generic — falls through to letter "B"
  [MapPointType.Shop]:     'map_shop.png',
  [MapPointType.Treasure]: 'map_chest.png',
  [MapPointType.RestSite]: 'map_rest.png',
  [MapPointType.Unknown]:  'map_unknown.png',
  [MapPointType.Ancient]:  'ancient_node_neow.png',      // Neow as generic ancient
};

// Per-boss icon by run file model_id. nulls = atlas-only bosses with no
// static-image variant in the PCK; the renderer falls back to a letter "B".
const BOSS_ICON_BY_MODEL = {
  // Overgrowth
  'ENCOUNTER.VANTOM_BOSS':              'vantom_boss_icon.png',
  'ENCOUNTER.CEREMONIAL_BEAST_BOSS':    'ceremonial_beast_boss_icon.png',  // sliced from Spine atlas
  'ENCOUNTER.THE_KIN_BOSS':             'the_kin_boss_icon.png',
  // Underdocks
  'ENCOUNTER.LAGAVULIN_MATRIARCH_BOSS': 'lagavulin_matriarch_boss_icon.png',
  'ENCOUNTER.SOUL_FYSH_BOSS':           'soul_fysh_boss_icon.png',
  'ENCOUNTER.WATERFALL_GIANT_BOSS':     'waterfall_giant_boss_icon.png',
  // Hive
  'ENCOUNTER.KAISER_CRAB_BOSS':         'kaiser_crab_boss_icon.png',
  'ENCOUNTER.KNOWLEDGE_DEMON_BOSS':     'knowledge_demon_boss_icon.png',
  'ENCOUNTER.THE_INSATIABLE_BOSS':      'the_insatiable_boss_icon.png',   // sliced from Spine atlas
  // Glory
  'ENCOUNTER.DOORMAKER_BOSS':           'doormaker_boss_icon.png',
  'ENCOUNTER.QUEEN_BOSS':               'false_queen_boss_icon.png',      // sliced from Spine atlas
  'ENCOUNTER.TEST_SUBJECT_BOSS':        'test_subject_boss_icon.png',
};

const RING_COLOR = {
  [MapPointType.Monster]:  '#1a1a1a',
  [MapPointType.Elite]:    '#5a2a78',
  [MapPointType.RestSite]: '#8b2a1f',
  [MapPointType.Shop]:     '#7a5a09',
  [MapPointType.Unknown]:  '#a07a00',
  [MapPointType.Boss]:     '#3a0d0d',
  [MapPointType.Treasure]: '#7a5e2a',
  [MapPointType.Ancient]:  '#4a2e6a',
};
const RING_DEFAULT = '#1a1a1a';

const FALLBACK_SYMBOL = {
  [MapPointType.Monster]:  'M', [MapPointType.Elite]:    'E',
  [MapPointType.Boss]:     'B', [MapPointType.Shop]:     '$',
  [MapPointType.Treasure]: 'T', [MapPointType.RestSite]: 'Z',
  [MapPointType.Unknown]:  '?', [MapPointType.Ancient]:  'A',
};

// ── Icon loading (cache key includes dir, in case different render calls
// target different roots) ───────────────────────────────────────────────────

const _iconCache = new Map();
function readIconUri(iconsDir, fname) {
  if (!fname) return null;
  const key = path.join(iconsDir, fname);
  if (_iconCache.has(key)) return _iconCache.get(key);
  try {
    const b64 = fs.readFileSync(key).toString('base64');
    const uri = `data:image/png;base64,${b64}`;
    _iconCache.set(key, uri);
    return uri;
  } catch (_) {
    _iconCache.set(key, null);
    return null;
  }
}

function iconFileFor(type, opts, bossIdx, iconsDir) {
  if (type === MapPointType.Boss) {
    const id = (opts.bossModelIds || [])[bossIdx];
    if (id && BOSS_ICON_BY_MODEL[id]) return BOSS_ICON_BY_MODEL[id];
    return ICON_FILES[type];
  }
  if (type === MapPointType.Ancient) {
    const id = opts.ancientModelId;            // e.g. "EVENT.NEOW"
    if (id) {
      const m = String(id).match(/EVENT\.(.+)$/);
      if (m) {
        const candidate = `ancient_node_${m[1].toLowerCase()}.png`;
        if (fs.existsSync(path.join(iconsDir, candidate))) return candidate;
      }
    }
    return ICON_FILES[type];
  }
  return ICON_FILES[type] || null;
}

// ── Backdrops ───────────────────────────────────────────────────────────────

function actIdToFolder(actId) {
  if (!actId) return null;
  const m = String(actId).match(/^ACT\.(.+)$/);
  return m ? m[1].toLowerCase() : String(actId).toLowerCase();
}

const _backdropCache = new Map();
function backdropDataUris(actId, backdropsDir) {
  const key = `${backdropsDir}::${actId}`;
  if (_backdropCache.has(key)) return _backdropCache.get(key);
  const folder = actIdToFolder(actId);
  if (!folder) { _backdropCache.set(key, null); return null; }
  const tryRead = (which) => {
    try {
      const buf = fs.readFileSync(path.join(backdropsDir, folder, `map_${which}_${folder}.png`));
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (_) { return null; }
  };
  const triple = { top: tryRead('top'), middle: tryRead('middle'), bottom: tryRead('bottom') };
  if (!triple.top && !triple.middle && !triple.bottom) {
    _backdropCache.set(key, null);
    return null;
  }
  _backdropCache.set(key, triple);
  return triple;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function nodePos(p, topRow) {
  const x = X_PAD + p.coord.col * COL_W;
  const y = Y_PAD + (topRow - p.coord.row) * ROW_H;
  return { x, y };
}

function edgeKey(a, b) {
  return `${a.coord.col},${a.coord.row}->${b.coord.col},${b.coord.row}`;
}

function bossScale(secondBossPoint) {
  return secondBossPoint ? 1.75 : 2.5;
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderSvg(graph, pathNodes, opts = {}) {
  const iconsDir     = opts.iconsDir     || ICONS_DIR_DEFAULT;
  const backdropsDir = opts.backdropsDir || BACKDROPS_DIR_DEFAULT;

  const { grid, gridCols, startingPoint, bossPoint, secondBossPoint } = graph;
  const allNodes = [
    startingPoint,
    ...getAllMapPoints(grid),
    bossPoint,
    ...(secondBossPoint ? [secondBossPoint] : []),
  ];

  const topRow = secondBossPoint ? secondBossPoint.coord.row : bossPoint.coord.row;
  const W = X_PAD * 2 + (gridCols - 1) * COL_W;
  const bScale = bossScale(secondBossPoint);
  const bossHalo = (RING_R * bScale) + 8;
  const H = Y_PAD * 2 + topRow * ROW_H + Math.max(0, bossHalo - Y_PAD);

  const pathEdgeSet = new Set();
  if (pathNodes && pathNodes.length > 1) {
    for (let i = 0; i < pathNodes.length - 1; i++) {
      pathEdgeSet.add(edgeKey(pathNodes[i], pathNodes[i + 1]));
    }
  }
  const pathNodeSet = new Set(pathNodes || []);

  const symbolDefs   = new Map();   // symbolId → fname
  const nodeSymbolId = new Map();   // node ref → symbolId
  let bossIdxCounter = 0;
  for (const p of allNodes) {
    if (!p) continue;
    let id, fname;
    if (p.PointType === MapPointType.Boss) {
      const idx = bossIdxCounter++;
      id = `icon-boss-${idx}`;
      fname = iconFileFor(MapPointType.Boss, opts, idx, iconsDir);
      if (fname) symbolDefs.set(id, fname);
    } else if (p.PointType === MapPointType.Ancient) {
      id = `icon-ancient`;
      fname = iconFileFor(MapPointType.Ancient, opts, 0, iconsDir);
      if (fname) symbolDefs.set(id, fname);
    } else {
      id = `icon-${p.PointType}`;
      if (!symbolDefs.has(id)) {
        fname = iconFileFor(p.PointType, opts, 0, iconsDir);
        if (fname) symbolDefs.set(id, fname);
      }
    }
    nodeSymbolId.set(p, id);
  }

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace">`);
  out.push(`<rect width="100%" height="100%" fill="#1a1a1a"/>`);

  const bd = opts.actId ? backdropDataUris(opts.actId, backdropsDir) : null;
  if (bd) {
    const stripH  = W * (1440 / 2036);
    const botY    = H - stripH;
    const midH    = Math.max(0, botY - stripH);
    if (bd.top)    out.push(`<image x="0" y="0" width="${W}" height="${stripH}" href="${bd.top}" preserveAspectRatio="none"/>`);
    if (bd.middle && midH > 0) out.push(`<image x="0" y="${stripH}" width="${W}" height="${midH}" href="${bd.middle}" preserveAspectRatio="none"/>`);
    if (bd.bottom) out.push(`<image x="0" y="${botY}" width="${W}" height="${stripH}" href="${bd.bottom}" preserveAspectRatio="none"/>`);
  }

  out.push(`<defs>`);
  for (const [id, fname] of symbolDefs) {
    const uri = readIconUri(iconsDir, fname);
    if (!uri) continue;
    out.push(`<symbol id="${id}" overflow="visible">`);
    out.push(`<image x="${-NODE_SZ/2}" y="${-NODE_SZ/2}" width="${NODE_SZ}" height="${NODE_SZ}" href="${uri}"/>`);
    out.push(`</symbol>`);
  }
  out.push(`</defs>`);

  // Edges. Trim each line by the parent's and child's effective ring radius.
  const drawnEdges = new Set();
  for (const p of allNodes) {
    if (!p) continue;
    const a = nodePos(p, topRow);
    const ra = (p.PointType === MapPointType.Boss) ? RING_R * bScale : RING_R;
    for (const c of p.Children) {
      const k = edgeKey(p, c);
      if (drawnEdges.has(k)) continue;
      drawnEdges.add(k);
      const b  = nodePos(c, topRow);
      const rb = (c.PointType === MapPointType.Boss) ? RING_R * bScale : RING_R;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len <= ra + rb) continue;
      const ux = dx / len, uy = dy / len;
      const x1 = a.x + ux * ra, y1 = a.y + uy * ra;
      const x2 = b.x - ux * rb, y2 = b.y - uy * rb;
      const onPath = pathEdgeSet.has(k);
      const stroke = onPath ? '#f4cf57' : '#3a3a3a';
      const sw     = onPath ? 4 : 1.5;
      out.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" stroke-width="${sw}"/>`);
    }
  }

  // Click hooks for path nodes.
  const clickByCoord = new Map();
  for (const c of (opts.clickableSteps || [])) {
    clickByCoord.set(`${c.col},${c.row}`, c);
  }

  // Nodes.
  for (const p of allNodes) {
    if (!p) continue;
    const { x, y } = nodePos(p, topRow);
    const visited  = pathNodeSet.has(p);
    const symId    = nodeSymbolId.get(p);
    const ringStroke = RING_COLOR[p.PointType] || RING_DEFAULT;
    const isBoss   = p.PointType === MapPointType.Boss;
    const scale    = isBoss ? bScale : 1;
    const ringR    = RING_R * scale;
    const ringSw   = isBoss ? 3 : 2;
    const haloSw   = isBoss ? 5 : 3;

    const click = clickByCoord.get(`${p.coord.col},${p.coord.row}`);
    const cls   = ['map-node'].concat(click ? ['map-node-clickable'] : []).join(' ');
    const dataAttrs = ` data-col="${p.coord.col}" data-row="${p.coord.row}"`
                    + ` data-type="${p.PointType}"`
                    + (click ? ` data-step-in-act="${click.nodeInAct}"` : '');
    const peAttr = click ? ` pointer-events="bounding-box"` : '';

    out.push(`<g class="${cls}"${dataAttrs}${peAttr}>`);

    if (visited) {
      out.push(`<circle cx="${x}" cy="${y}" r="${ringR + 4}" fill="none" stroke="#f4cf57" stroke-width="${haloSw}"/>`);
    }
    out.push(`<circle cx="${x}" cy="${y}" r="${ringR}" fill="none" stroke="${ringStroke}" stroke-width="${ringSw}"/>`);

    if (symId && symbolDefs.has(symId)) {
      // PCK-extracted icons are full-colour with their own alpha; no luminance
      // mask or tint filter needed — paint them straight.
      if (scale !== 1) {
        out.push(`<use href="#${symId}" transform="translate(${x} ${y}) scale(${scale})"/>`);
      } else {
        out.push(`<use href="#${symId}" x="${x}" y="${y}"/>`);
      }
    } else {
      const sym = FALLBACK_SYMBOL[p.PointType] || '?';
      out.push(`<text x="${x}" y="${y + 5 * scale}" text-anchor="middle" fill="#222" font-size="${14 * scale}" font-weight="bold">${sym}</text>`);
    }

    out.push(`</g>`);
  }

  out.push(`</svg>`);
  return out.join('\n');
}

module.exports = { renderSvg };
