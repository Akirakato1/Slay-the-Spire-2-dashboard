'use strict';
/**
 * renderer.js — Canvas-based STS2 card renderer.
 *
 * JS port of WanderZil/Slay-the-Spire-2-Card-Maker `renderer.py`. Render path
 * is 8 steps: art → frame → portrait border → banner → energy+cost →
 * type plaque → description → title. Color shifts use the same YIQ-space
 * hue/sat/value math the Python uses, so output should match pixel-for-pixel
 * modulo font hinting / canvas anti-aliasing.
 *
 * API (after `await preload()`):
 *   renderCard(cfg) → HTMLCanvasElement   (synchronous; portrait must be in cfg)
 *
 * `cfg` shape (matches Python CardConfig + a portrait *image* instead of path):
 *   { card_name, description, card_type, character, rarity, cost, upgraded,
 *     cost_green, portrait_image }   // portrait_image: HTMLImageElement | null
 */

// ── Asset paths ─────────────────────────────────────────────────────────────

const A = (sub) => `cardassets://${sub}`;

const FRAME_PATHS = {
  attack:  A('Frame/frame_attack.png'),
  skill:   A('Frame/frame_skill.png'),
  power:   A('Frame/frame_power.png'),
  quest:   A('Frame/frame_quest.png'),
  ancient: A('Frame/frame_ancient.png'),
};
const BANNER_PATHS = {
  card:    A('Banner/banner.png'),
  ancient: A('Banner/banner_ancient.png'),
};
const ENERGY_PATHS = {
  ironclad:    A('Mana/energy_ironclad.png'),
  silent:      A('Mana/energy_silent.png'),
  defect:      A('Mana/energy_defect.png'),
  necrobinder: A('Mana/energy_necrobinder.png'),
  regent:      A('Mana/energy_regent.png'),
  colorless:   A('Mana/energy_colorless.png'),
};
const PORTRAIT_BORDER_PATHS = {
  attack: A('Portrait/portrait_attack.png'),
  skill:  A('Portrait/portrait_skill.png'),
  power:  A('Portrait/portrait_power.png'),
};
const PLAQUE_PATH = A('Portrait/portrait_plaque.png');
const STAR_ICON_PATH      = A('Icons/star_icon.png');
const STAR_COST_ICON_PATH = A('Icons/star_cost.png');
// Ancient-card flame overlay. Sits at the top-center of the card's banner
// area. (The portrait corner clip is now a pure software rounded-rect —
// see `_roundedMask` and `LAYOUT.ancient_clip_radius`. We previously also
// shipped a PNG portrait mask but its corners didn't line up with the
// frame's cutout, so it's been removed in favor of the rounded rect.)
const ANCIENT_FLAME_PATH = A('Ancient/flame.png');

// ── Color tables (from WanderZil manifest.json) ─────────────────────────────
// `h` is in turns (0..1, multiplied by 2π in YIQ rotation). `s` and `v` are
// linear scalars applied to the YIQ chroma and the final RGB respectively.

const BANNER_HSV = {
  basic:    { h: 1.0,   s: 0.0,   v: 0.85 },
  common:   { h: 1.0,   s: 0.0,   v: 0.85 },
  uncommon: { h: 1.0,   s: 1.0,   v: 1.0  },
  rare:     { h: 0.563, s: 1.198, v: 1.14 },
  curse:    { h: 0.27,  s: 1.1,   v: 0.9  },
  event:    { h: 0.875, s: 0.85,  v: 0.9  },
  quest:    { h: 0.515, s: 1.727, v: 0.9  },
  status:   { h: 0.634, s: 0.35,  v: 0.8  },
  ancient:  { h: 0.0,   s: 0.2,   v: 0.9  },
};
const FRAME_HSV = {
  ironclad:    { h: 0.025, s: 0.85, v: 1.0 },
  silent:      { h: 0.32,  s: 0.45, v: 1.2 },
  defect:      { h: 0.55,  s: 0.9,  v: 1.0 },
  necrobinder: { h: 0.965, s: 0.55, v: 1.2 },
  regent:      { h: 0.12,  s: 1.5,  v: 1.2 },
  colorless:   { h: 1.0,   s: 0.0,  v: 1.2 },
  quest:       { h: 1.0,   s: 1.0,  v: 1.0 },
  // Curse / status frames keep the skill-frame shape but darken to near-
  // black. Decoupled from BANNER_HSV so the banner can stay color-tinted
  // for legibility while the frame body goes dark.
  curse:       { h: 1.0,   s: 0.0,  v: 0.20 },
  status:      { h: 1.0,   s: 0.0,  v: 0.35 },
};

// ── Layout (from WanderZil LayoutConfig) ────────────────────────────────────

const LAYOUT = {
  card_w: 598, card_h: 844, out_w: 748, out_h: 876,
  canvas_offset_x: 0, canvas_offset_y: 16,
  user_art_box:    [50, 86, 498, 380],   // x, y, w, h (within card-frame coords)
  ancient_art_box: [10, 10, 575, 820],
  ancient_clip_radius: 36,
  portrait_border_rect: [24, 94, 550, 420],
  energy_pos:  [-32, -24],
  energy_size: 110,
  cost_y_offset: 0,
  banner_y_normal:  22,
  banner_h:        133,
  banner_h_ancient: 162,
  banner_w_scale:  1.075,
  title_y_normal:  28,
  title_y_ancient: 48,
  type_plaque_rect: [239, 424, 122, 74],
  desc_max_width: 480,
  desc_center_y:  590,
  desc_line_h:    42,
};

const TYPE_LABELS = { attack: 'Attack', skill: 'Skill', power: 'Power' };

const ENERGY_ICON_SIZE   = 28;
const ENERGY_ICON_GAP    =  2;
const STAR_ICON_SIZE     = 28;
const STAR_ICON_GAP      =  2;
const DESC_ICON_TOP_OFFSET = 10;

// ── Asset loading ───────────────────────────────────────────────────────────

const _imgCache = new Map();
function _load(src) {
  if (_imgCache.has(src)) return _imgCache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
  _imgCache.set(src, p);
  return p;
}

let _assets = null;

async function preload() {
  if (_assets) return _assets;

  // Load all card-render assets in parallel.
  const [
    fa, fs, fp, fq, fan,    // frames
    ba, ban,                // banners
    ei, es, ed, en, er, ec, // energy
    pa, ps, pp,             // portrait borders
    plaque, star, starCostIcon,
    ancientFlame,
  ] = await Promise.all([
    _load(FRAME_PATHS.attack), _load(FRAME_PATHS.skill), _load(FRAME_PATHS.power),
    _load(FRAME_PATHS.quest),  _load(FRAME_PATHS.ancient),
    _load(BANNER_PATHS.card),  _load(BANNER_PATHS.ancient),
    _load(ENERGY_PATHS.ironclad), _load(ENERGY_PATHS.silent), _load(ENERGY_PATHS.defect),
    _load(ENERGY_PATHS.necrobinder), _load(ENERGY_PATHS.regent), _load(ENERGY_PATHS.colorless),
    _load(PORTRAIT_BORDER_PATHS.attack), _load(PORTRAIT_BORDER_PATHS.skill), _load(PORTRAIT_BORDER_PATHS.power),
    _load(PLAQUE_PATH), _load(STAR_ICON_PATH),
    _load(STAR_COST_ICON_PATH).catch(() => null),
    _load(ANCIENT_FLAME_PATH).catch(() => null),
  ]);

  // Force the Kreon webfont to actually download. @font-face rules in CSS
  // are lazy — the browser only fetches the file when an element uses the
  // family. Canvas's `ctx.font = "50px Kreon"` does NOT trigger that load,
  // so without an explicit document.fonts.load() the first few canvases
  // render with a serif fallback (visibly blurry vs. later renders that
  // hit the loaded face). We force-load every (weight × size) the renderer
  // actually uses; document.fonts.ready then waits for them to finish.
  if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
    try {
      await Promise.all([
        document.fonts.load('700 50px "STS Card Name"'),  // title
        document.fonts.load('700 62px "STS Card Name"'),  // mana cost
        document.fonts.load('700 50px "STS Card Name"'),  // star cost
        document.fonts.load('700 30px "STS Card Name"'),  // type plaque label
        document.fonts.load('400 38px "Kreon"'),           // body
      ]);
    } catch (_) {}
  }
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (_) {}
  }

  _assets = {
    frames:  { attack: fa, skill: fs, power: fp, quest: fq, ancient: fan },
    banners: { card: ba, ancient: ban },
    energy:  { ironclad: ei, silent: es, defect: ed, necrobinder: en, regent: er, colorless: ec },
    borders: { attack: pa, skill: ps, power: pp },
    plaque, star, starCostIcon,
    ancientFlame,
  };
  return _assets;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function _coverResize(srcImg, w, h) {
  const sw = srcImg.naturalWidth || srcImg.width;
  const sh = srcImg.naturalHeight || srcImg.height;
  const srcRatio = sw / sh;
  const dstRatio = w / h;
  let cropX = 0, cropY = 0, cropW = sw, cropH = sh;
  if (srcRatio > dstRatio) {
    cropW = Math.floor(sh * dstRatio);
    cropX = Math.floor((sw - cropW) / 2);
  } else {
    cropH = Math.floor(sw / dstRatio);
    cropY = Math.floor((sh - cropH) / 2);
  }
  const out = _newCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImg, cropX, cropY, cropW, cropH, 0, 0, w, h);
  return out;
}

// 3x3 matrix utilities for HSV/YIQ math.
function _mat3Mul(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
    C[i][j] = s;
  }
  return C;
}
function _mat3Inv(M) {
  const a=M[0][0],b=M[0][1],c=M[0][2];
  const d=M[1][0],e=M[1][1],f=M[1][2];
  const g=M[2][0],h=M[2][1],i=M[2][2];
  const det = a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
  return [
    [(e*i-f*h)/det, (c*h-b*i)/det, (b*f-c*e)/det],
    [(f*g-d*i)/det, (a*i-c*g)/det, (c*d-a*f)/det],
    [(d*h-e*g)/det, (b*g-a*h)/det, (a*e-b*d)/det],
  ];
}

// YIQ basis (matches WanderZil/numpy).
const RGB_TO_YIQ = [
  [0.2989,  0.5870,  0.1140],
  [0.5959, -0.2774, -0.3216],
  [0.2115, -0.5229,  0.3114],
];
const YIQ_TO_RGB = _mat3Inv(RGB_TO_YIQ);

/**
 * Build the per-pixel 3x3 RGB transform implementing WanderZil's
 *   yiq = M @ rgb;  yiq = HS @ yiq;  yiq *= v;  rgb' = M^-1 @ yiq
 * folded into one matrix so the per-pixel cost is 9 muls + 6 adds.
 */
function _buildHsvMatrix(h, s, v) {
  const hue = (1 - h) * 2 * Math.PI;
  const c = Math.cos(hue), si = Math.sin(hue);
  // Combined hue+sat in YIQ space (Y untouched; rotate then scale I,Q).
  const HS = [
    [1, 0, 0],
    [0, s*c,  -s*si],
    [0, s*si,  s*c ],
  ];
  let T = _mat3Mul(YIQ_TO_RGB, _mat3Mul(HS, RGB_TO_YIQ));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i][j] *= v;
  return T;
}

/**
 * Layer cache. Frame / banner / portrait-border / plaque tinting is the
 * dominant per-render cost (each pass walks 500K+ pixels). Most cards in a
 * deck share the same source asset + same HSV inputs (same character → same
 * frame tint, same rarity → same banner tint), so we memoize the resize-
 * and-tint pipeline. First card pays full cost; remaining same-class cards
 * reuse the cached canvas. Cache survives across renders within the
 * helper's lifetime — cleared via `_clearLayerCache()` if needed.
 */
const _LAYER_CACHE = new Map();
function _clearLayerCache() { _LAYER_CACHE.clear(); }

// Resize a source image to (w, h), then HSV-tint. Cached by source URL +
// dimensions + HSV. Used for banner / portrait-border / plaque.
function _resizedTintedCached(srcImg, w, h, hH, sH, vH) {
  const srcKey = (srcImg && srcImg.src) || '?';
  const key = `${srcKey}|${w}x${h}|${hH}|${sH}|${vH}`;
  const hit = _LAYER_CACHE.get(key);
  if (hit) return hit;
  const resized = _newCanvas(w, h);
  const rctx = resized.getContext('2d');
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(srcImg, 0, 0, w, h);
  const out = (hH === 1.0 && sH === 1.0 && vH === 1.0) ? resized : _applyHsv(resized, hH, sH, vH);
  _LAYER_CACHE.set(key, out);
  return out;
}

// HSV-tint a source image (no resize — drawn at its natural size). Used
// for the full-card frame layer.
function _tintImageCached(srcImg, hH, sH, vH) {
  const srcKey = (srcImg && srcImg.src) || '?';
  const key = `${srcKey}|tint|${hH}|${sH}|${vH}`;
  const hit = _LAYER_CACHE.get(key);
  if (hit) return hit;
  const out = _applyHsv(srcImg, hH, sH, vH);
  _LAYER_CACHE.set(key, out);
  return out;
}

/**
 * Apply HSV shift (WanderZil convention) on an image/canvas; returns a new
 * canvas of the same size. Pixels are processed in normalized 0..1 RGB space.
 * Alpha is preserved as-is.
 */
function _applyHsv(srcImgOrCanvas, h, s, v) {
  const w = srcImgOrCanvas.naturalWidth  || srcImgOrCanvas.width;
  const hh = srcImgOrCanvas.naturalHeight || srcImgOrCanvas.height;
  const out = _newCanvas(w, hh);
  const ctx = out.getContext('2d');
  ctx.drawImage(srcImgOrCanvas, 0, 0, w, hh);

  // Identity short-circuit — saves ~25ms on a common card.
  if (h === 1.0 && s === 1.0 && v === 1.0) return out;

  const id = ctx.getImageData(0, 0, w, hh);
  const d  = id.data;
  const T  = _buildHsvMatrix(h, s, v);
  const t00=T[0][0], t01=T[0][1], t02=T[0][2];
  const t10=T[1][0], t11=T[1][1], t12=T[1][2];
  const t20=T[2][0], t21=T[2][1], t22=T[2][2];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] === 0) continue;
    const r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
    let nr = t00*r + t01*g + t02*b;
    let ng = t10*r + t11*g + t12*b;
    let nb = t20*r + t21*g + t22*b;
    if (nr < 0) nr = 0; else if (nr > 1) nr = 1;
    if (ng < 0) ng = 0; else if (ng > 1) ng = 1;
    if (nb < 0) nb = 0; else if (nb > 1) nb = 1;
    d[i]   = (nr * 255) | 0;
    d[i+1] = (ng * 255) | 0;
    d[i+2] = (nb * 255) | 0;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// Make a soft-edged rounded-rect mask. Used to round ancient art corners.
function _roundedMask(w, h, radius) {
  const c = _newCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, w, h, radius);
  else _roundRectFallback(ctx, 0, 0, w, h, radius);
  ctx.fill();
  return c;
}
function _roundRectFallback(ctx, x, y, w, h, r) {
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

function _charKey(character) {
  const s = String(character || '').trim().toLowerCase();
  if (s === 'the regent' || s === 'regent') return 'regent';
  if (['ironclad','silent','defect','necrobinder','colorless','quest'].includes(s)) return s;
  if (['status','curse','event','token'].includes(s)) return 'colorless';
  return 'colorless';
}

function _typeLabel(cfg) {
  if (cfg.character === 'quest') return 'Quest';
  return TYPE_LABELS[cfg.card_type] || (cfg.card_type[0].toUpperCase() + cfg.card_type.slice(1));
}

function _normalizeSpecialPool(cfg) {
  const out = { ...cfg };
  if (out.character === 'quest')  { out.card_type = 'skill'; out.rarity = 'quest';  }
  if (out.character === 'status') { out.card_type = 'skill'; out.rarity = 'status'; }
  if (out.character === 'curse')  { out.card_type = 'skill'; out.rarity = 'curse';  }
  return out;
}

function _frameImage(cfg) {
  // Special-pool rarities have their own dedicated frame asset, regardless
  // of the card_type that _normalizeSpecialPool rewrote them to.
  if (cfg.rarity === 'ancient') return _assets.frames.ancient;
  if (cfg.rarity === 'quest')   return _assets.frames.quest;
  return _assets.frames[cfg.card_type] || _assets.frames.skill;
}
function _portraitBorderImage(cfg) {
  if (cfg.rarity === 'ancient') return null;
  return _assets.borders[cfg.card_type] || null;
}
function _bannerImage(cfg) {
  return cfg.rarity === 'ancient' ? _assets.banners.ancient : _assets.banners.card;
}
function _energyImage(cfg) {
  return _assets.energy[_charKey(cfg.character)];
}
function _descIconImage(cfg) {
  // The inline `[energy:N]` orbs in the body always follow deck context, so
  // this picks up `cfg.desc_icon_character` (set by the adapter from
  // runContext) and only falls back to the card's own character when the
  // adapter didn't set one.
  const ch = cfg.desc_icon_character || cfg.character;
  return _assets.energy[_charKey(ch)];
}

// ── Text rendering ──────────────────────────────────────────────────────────

// Canvas's `textBaseline = 'top'` puts the top of the em box at y, but the
// font's actual cap-height starts a few px below that — so a y value tuned
// for PIL (which uses the cap-height as the anchor) renders too high in
// canvas. This fraction of the font size is the empirical gap for Kreon;
// applied at every text draw so vertical alignment matches PIL output.
const TEXT_TOP_PAD_FRAC = 0.15;

function _setFont(ctx, weight, size) {
  // Name and Desc both use Kreon (game font, extracted by the pipeline).
  ctx.font = `${weight} ${size}px "STS Card Name", "Kreon", serif`;
}

function _yTop(fontSize, y) { return y + fontSize * TEXT_TOP_PAD_FRAC; }

function _measureWidth(ctx, text) {
  return ctx.measureText(text).width;
}

function _drawTextWithStrokeShadow(ctx, x, y, text, fill, stroke, strokeW, shadow = null) {
  if (shadow && (shadow.dx || shadow.dy)) {
    ctx.fillStyle = `rgba(0,0,0,${shadow.alpha ?? 0.25})`;
    ctx.fillText(text, x + shadow.dx, y + shadow.dy);
  }
  if (strokeW > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = strokeW * 2;  // canvas stroke straddles, double for visual parity with PIL
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// Description parser. Supports both spire-codex and WanderZil markup.
//   Color tags (open + close pairs):
//     [gold] [green] [purple] [blue] [red] [orange] [aqua]
//   Style tag:
//     [b]…[/b]       (bold; rendered as gold-fill for now since canvas already
//                     uses a bold weight for the body — close enough)
//   Pass-through (animation tags surround text we still want visible):
//     [sine] [jitter] [wave] [shake]
//   Inline icons:
//     [energy:N]  [star:N]                       (spire-codex)
//     {X:energyIcons(N)}  {X:starIcons(N)}  {singleStarIcon}  (WanderZil)
//   Legacy: bare `{…}` → yellow text
const _COLORS_OPEN = ['gold', 'green', 'purple', 'blue', 'red', 'orange', 'aqua'];
const _PASSTHROUGH = ['b', 'sine', 'jitter', 'wave', 'shake'];

function _parseDescLine(line) {
  const segs = [];
  let buf = '';
  let i = 0;
  // Stack tracks active color (latest pushed wins). Pass-through tags are
  // dropped so they don't affect color but their content still renders.
  const colorStack = [];
  let yellow = false;
  const style = () => (colorStack.length ? colorStack[colorStack.length - 1] : (yellow ? 'yellow' : 'normal'));
  const flush = () => { if (buf) { segs.push({ kind: 'text', text: buf, style: style() }); buf = ''; } };

  while (i < line.length) {
    const rest = line.slice(i);

    // Color open / close tags.
    let matched = false;
    for (const c of _COLORS_OPEN) {
      const open  = `[${c}]`;
      const close = `[/${c}]`;
      if (rest.slice(0, open.length).toLowerCase() === open) {
        flush(); colorStack.push(c); i += open.length; matched = true; break;
      }
      if (rest.slice(0, close.length).toLowerCase() === close) {
        flush();
        const idx = colorStack.lastIndexOf(c);
        if (idx !== -1) colorStack.splice(idx, 1);
        i += close.length; matched = true; break;
      }
    }
    if (matched) continue;

    // Pass-through (style/animation) tags — strip the markers, keep content.
    for (const t of _PASSTHROUGH) {
      const open  = `[${t}]`;
      const close = `[/${t}]`;
      if (rest.slice(0, open.length).toLowerCase()  === open)  { flush(); i += open.length;  matched = true; break; }
      if (rest.slice(0, close.length).toLowerCase() === close) { flush(); i += close.length; matched = true; break; }
    }
    if (matched) continue;

    // Spire-codex inline icons.
    let m = rest.match(/^\[energy:(\d+)\]/i);
    if (m) {
      flush(); segs.push({ kind: 'energy', count: Math.max(1, parseInt(m[1], 10)) });
      i += m[0].length; continue;
    }
    m = rest.match(/^\[star:(\d+)\]/i);
    if (m) {
      flush(); segs.push({ kind: 'star', count: Math.max(1, parseInt(m[1], 10)) });
      i += m[0].length; continue;
    }

    // WanderZil legacy syntax.
    if (rest.startsWith('{singleStarIcon}')) {
      flush(); segs.push({ kind: 'star', count: 1 }); i += '{singleStarIcon}'.length; continue;
    }
    m = rest.match(/^\{(\w+):energyIcons(?:\((\d*)\))?\}/);
    if (m) {
      flush();
      const count = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
      segs.push({ kind: 'energy', count });
      i += m[0].length; continue;
    }
    m = rest.match(/^\{(\w+):starIcons(?:\((\d*)\))?\}/);
    if (m) {
      flush();
      const count = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
      segs.push({ kind: 'star', count });
      i += m[0].length; continue;
    }
    if (line[i] === '{') { flush(); yellow = true;  i += 1; continue; }
    if (line[i] === '}') { flush(); yellow = false; i += 1; continue; }
    buf += line[i]; i += 1;
  }
  flush();
  return segs;
}

// Tokenize a parsed-segment list into atomic drawables with measured widths.
// Text segments are split on whitespace so the wrap pass has word boundaries
// to break on; icon segments are atomic. Whitespace-only text tokens are
// flagged so we can drop leading/trailing spaces at line edges.
function _tokenize(segs, ctx, fontSize) {
  _setFont(ctx, 'normal', fontSize);
  const tokens = [];
  for (const seg of segs) {
    if (seg.kind === 'text') {
      const parts = seg.text.match(/(\s+|\S+)/g) || [];
      for (const p of parts) {
        const isSpace = /^\s+$/.test(p);
        const w = _measureWidth(ctx, p);
        tokens.push({ kind: 'text', text: p, style: seg.style, w, isSpace });
      }
    } else if (seg.kind === 'energy') {
      const c = seg.count;
      let w;
      if (c >= 4) {
        w = _measureWidth(ctx, String(c)) + ENERGY_ICON_GAP + ENERGY_ICON_SIZE;
      } else {
        w = c * ENERGY_ICON_SIZE + Math.max(0, c - 1) * ENERGY_ICON_GAP;
      }
      tokens.push({ kind: 'energy', count: c, w, isSpace: false });
    } else if (seg.kind === 'star') {
      const c = seg.count;
      const w = c * STAR_ICON_SIZE + Math.max(0, c - 1) * STAR_ICON_GAP;
      tokens.push({ kind: 'star', count: c, w, isSpace: false });
    }
  }
  return tokens;
}

// Greedy fill: pack tokens onto lines, breaking when the next token would
// push the line past `maxWidth`. Whitespace tokens at line boundaries are
// dropped so wrapped text doesn't get stray indents.
function _wrapTokens(tokens, maxWidth) {
  const lines = [];
  let cur = [], curW = 0;
  for (const t of tokens) {
    if (cur.length === 0 && t.isSpace) continue;             // skip leading WS
    if (cur.length > 0 && curW + t.w > maxWidth) {
      while (cur.length && cur[cur.length - 1].isSpace) curW -= cur.pop().w;
      if (cur.length) lines.push({ tokens: cur, width: curW });
      if (t.isSpace) { cur = []; curW = 0; continue; }       // wrap on a space
      cur = [t]; curW = t.w;
    } else {
      cur.push(t); curW += t.w;
    }
  }
  while (cur.length && cur[cur.length - 1].isSpace) curW -= cur.pop().w;
  if (cur.length) lines.push({ tokens: cur, width: curW });
  return lines;
}

function _drawWrappedLine(cardCtx, line, y, fontSize, energyImg, starImg) {
  _setFont(cardCtx, 'normal', fontSize);
  cardCtx.textBaseline = 'top';
  const yT = _yTop(fontSize, y);

  let x = ((LAYOUT.card_w - line.width) / 2) | 0;

  for (const t of line.tokens) {
    if (t.kind === 'energy') {
      const c = t.count;
      if (c >= 4) {
        const num = String(c);
        _drawTextWithStrokeShadow(
          cardCtx, x, yT, num,
          'rgba(255,247,237,1)', 'rgba(60,55,50,1)', 0,
        );
        x += _measureWidth(cardCtx, num) + ENERGY_ICON_GAP;
        cardCtx.drawImage(energyImg, x, y + DESC_ICON_TOP_OFFSET, ENERGY_ICON_SIZE, ENERGY_ICON_SIZE);
        x += ENERGY_ICON_SIZE;
      } else {
        for (let idx = 0; idx < c; idx++) {
          cardCtx.drawImage(energyImg, x, y + DESC_ICON_TOP_OFFSET, ENERGY_ICON_SIZE, ENERGY_ICON_SIZE);
          x += ENERGY_ICON_SIZE + (idx < c - 1 ? ENERGY_ICON_GAP : 0);
        }
      }
      continue;
    }
    if (t.kind === 'star') {
      for (let idx = 0; idx < t.count; idx++) {
        cardCtx.drawImage(starImg, x, y + DESC_ICON_TOP_OFFSET, STAR_ICON_SIZE, STAR_ICON_SIZE);
        x += STAR_ICON_SIZE + (idx < t.count - 1 ? STAR_ICON_GAP : 0);
      }
      continue;
    }
    let fill = 'rgba(255,247,237,1)';
    let stroke = 'rgba(60,55,50,1)';
    if (t.style === 'green')                              { fill = 'rgba(127,255,0,1)';   stroke = 'rgba(50,80,0,1)';  }
    else if (t.style === 'gold' || t.style === 'yellow')  { fill = 'rgba(255,225,80,1)';  stroke = 'rgba(89,64,10,1)'; }
    else if (t.style === 'purple')                        { fill = 'rgba(190,120,230,1)'; stroke = 'rgba(60,30,90,1)'; }
    else if (t.style === 'blue')                          { fill = 'rgba(93,173,226,1)';  stroke = 'rgba(20,50,80,1)'; }
    else if (t.style === 'red')                           { fill = 'rgba(255,107,107,1)'; stroke = 'rgba(80,15,15,1)'; }
    else if (t.style === 'orange')                        { fill = 'rgba(255,153,51,1)';  stroke = 'rgba(80,40,10,1)'; }
    else if (t.style === 'aqua')                          { fill = 'rgba(77,219,230,1)';  stroke = 'rgba(15,60,70,1)'; }
    _drawTextWithStrokeShadow(cardCtx, x, yT, t.text, fill, stroke, 0);
    x += t.w;
  }
}

// ── Main render ─────────────────────────────────────────────────────────────

function renderCard(cfgIn, shellImg = null) {
  if (!_assets) throw new Error('renderer.preload() not awaited yet.');

  // Normalize keys + special-pool overrides.
  const cfg = _normalizeSpecialPool({
    card_name:           cfgIn.card_name   ?? 'Card',
    description:         cfgIn.description ?? '',
    card_type:           String(cfgIn.card_type           || 'skill').toLowerCase(),
    character:           String(cfgIn.character           || 'colorless').toLowerCase(),
    desc_icon_character: cfgIn.desc_icon_character
                          ? String(cfgIn.desc_icon_character).toLowerCase()
                          : null,
    rarity:              String(cfgIn.rarity              || 'common').toLowerCase(),
    cost:                cfgIn.cost == null ? '' : String(cfgIn.cost),
    // -1 means "no star cost"; anything else (number or 'X') is renderable.
    star_cost:           cfgIn.star_cost ?? -1,
    upgraded:            !!cfgIn.upgraded,
    cost_green:          !!cfgIn.cost_green,
    portrait_image:      cfgIn.portrait_image || null,
  });

  // Ancient cards have a complex portrait mask that needs per-card runtime
  // compositing — skip the shell fast path for them. Only ~6 cards are
  // affected so the perf hit is negligible.
  if (shellImg && cfg.rarity === 'ancient') shellImg = null;

  const isAncient = cfg.rarity === 'ancient';
  const ly = LAYOUT;

  const canvas = _newCanvas(ly.out_w, ly.out_h);
  const cctx   = canvas.getContext('2d');

  const offx = ((ly.out_w - ly.card_w) >> 1) + ly.canvas_offset_x;
  const offy = ((ly.out_h - ly.card_h) >> 1) + ly.canvas_offset_y;

  // Two drawing paths:
  //   1. No shell: build the card on a private inner canvas, composite to
  //      outer at (offx, offy) at the end. (Original code path.)
  //   2. Shell available: skip the inner canvas entirely. Draw the shell
  //      onto outer first; subsequent inner-card-coordinate work happens
  //      directly on the outer ctx with a (offx, offy) translation in
  //      effect. Translation is removed before the outer-canvas-only
  //      passes (banner overlay, cost orb, title) run.
  let card = null;
  let ctx;
  if (shellImg) {
    cctx.drawImage(shellImg, 0, 0);
    cctx.save();
    cctx.translate(offx, offy);
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    ctx = cctx;
  } else {
    card = _newCanvas(ly.card_w, ly.card_h);
    ctx  = card.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  const bannerHsv = BANNER_HSV[cfg.rarity] || BANNER_HSV.common;
  // Curse and status share the skill-frame asset (see _normalizeSpecialPool),
  // so their visual identity comes from the HSV tint. Special-pool rarities
  // pick from FRAME_HSV by rarity instead of by character so curses get the
  // dark "near-black" look they have in-game rather than the colorless gray.
  const frameHsv  = FRAME_HSV[cfg.rarity]
                 || FRAME_HSV[_charKey(cfg.character)]
                 || FRAME_HSV.ironclad;

  // 1) Art layer. With a shell, the shell already includes the frame (with
  // an alpha-cutout for the portrait window) so we draw the portrait UNDER
  // it via destination-over. Without a shell, art goes onto the inner canvas
  // and the frame paints over it next.
  {
    const [ax, ay, aw, ah] = isAncient ? ly.ancient_art_box : ly.user_art_box;
    if (shellImg) {
      // Shell-path always non-ancient (filtered above). Draw portrait beneath
      // the already-painted shell.
      cctx.save();
      cctx.globalCompositeOperation = 'destination-over';
      if (cfg.portrait_image) {
        const fitted = _coverResize(cfg.portrait_image, aw, ah);
        cctx.drawImage(fitted, ax, ay);
      } else {
        cctx.fillStyle = 'rgba(26,26,26,1)';
        cctx.fillRect(ax, ay, aw, ah);
      }
      cctx.restore();
    } else if (cfg.portrait_image) {
      const fitted = _coverResize(cfg.portrait_image, aw, ah);
      if (isAncient) {
        // Software rounded-rect mask aligned to the PORTRAIT box
        // (ax, ay, aw, ah), not the full card. A full-card mask's curves
        // sit at the card's outer edge, beyond where the portrait lives,
        // so they never actually intersect the portrait's corners. Tune
        // `ancient_clip_radius` in LAYOUT to taste.
        const layer = _newCanvas(ly.card_w, ly.card_h);
        const lctx = layer.getContext('2d');
        lctx.drawImage(fitted, ax, ay);
        lctx.globalCompositeOperation = 'destination-in';
        lctx.fillStyle = '#fff';
        lctx.beginPath();
        if (lctx.roundRect) lctx.roundRect(ax, ay, aw, ah, ly.ancient_clip_radius);
        else _roundRectFallback(lctx, ax, ay, aw, ah, ly.ancient_clip_radius);
        lctx.fill();
        lctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(layer, 0, 0);
      } else {
        ctx.drawImage(fitted, ax, ay);
      }
    } else {
      ctx.fillStyle = 'rgba(26,26,26,1)';
      ctx.fillRect(ax, ay, aw, ah);
    }
  }

  // 2) Frame — cached: same (frame asset, character HSV) tuple recurs
  // across every same-character same-type card in a deck. Skip when a shell
  // is in use; the shell already has the frame baked in.
  if (!shellImg) {
    const frameImg = _frameImage(cfg);
    const tinted   = _tintImageCached(frameImg, frameHsv.h, frameHsv.s, frameHsv.v);
    ctx.drawImage(tinted, 0, 0, ly.card_w, ly.card_h);
  }

  // 3) Portrait border — cached on (border asset, target rect, rarity HSV).
  // Skipped under shell (baked).
  if (!shellImg) {
    const borderImg = _portraitBorderImage(cfg);
    if (borderImg) {
      const [bx, by, bw, bh] = ly.portrait_border_rect;
      const tinted = _resizedTintedCached(borderImg, bw, bh, bannerHsv.h, bannerHsv.s, bannerHsv.v);
      ctx.drawImage(tinted, bx, by);
    }
  }

  // 4) Banner — cached on (banner asset, target dims, rarity HSV).
  // Drawn on outer canvas so the ribbon overflow isn't clipped. Skipped
  // under shell (baked).
  let bannerLayer = null;
  let bannerX = 0, bannerY = 0, bannerW = 0, bannerH = 0;
  if (!shellImg) {
    const bImg = _bannerImage(cfg);
    bannerH = isAncient ? ly.banner_h_ancient : ly.banner_h;
    const srcW = bImg.naturalWidth, srcH = bImg.naturalHeight;
    bannerW = ((srcW * bannerH) / srcH * ly.banner_w_scale) | 0;
    bannerLayer = isAncient
      ? _resizedTintedCached(bImg, bannerW, bannerH, 1.0, 1.0, 1.0)  // identity = resize-only
      : _resizedTintedCached(bImg, bannerW, bannerH, bannerHsv.h, bannerHsv.s, bannerHsv.v);
    bannerX = offx + ((ly.card_w - bannerW) >> 1);
    bannerY = offy + ly.banner_y_normal;
  }

  // 5) Energy + cost (deferred to after card composite — preserve top-left overflow)
  const noEnergy = cfg.character === 'quest' || cfg.character === 'curse';
  let energyLayer = null;
  let energyX = 0, energyY = 0;
  let costText = '', costTx = 0, costTy = 0;
  if (cfg.cost && cfg.cost.trim() && !noEnergy) {
    const eImg    = _energyImage(cfg);
    const e       = _newCanvas(ly.energy_size, ly.energy_size);
    const ectx    = e.getContext('2d');
    ectx.imageSmoothingEnabled = true;
    ectx.imageSmoothingQuality = 'high';
    ectx.drawImage(eImg, 0, 0, ly.energy_size, ly.energy_size);
    energyLayer = e;
    energyX = offx + ly.energy_pos[0];
    energyY = offy + ly.energy_pos[1];

    costText = String(cfg.cost).slice(0, 2);
    cctx.save();
    _setFont(cctx, 'bold', 62);
    cctx.textBaseline = 'top';
    const tw = _measureWidth(cctx, costText);
    cctx.restore();
    costTx = energyX + (ly.energy_size >> 1) - (tw >> 1) - 3;
    costTy = energyY + (ly.energy_size >> 1) - 40 + ly.cost_y_offset;
  }

  // 6) Type plaque + label — cached on (plaque asset, target dims, rarity HSV).
  // Skipped under shell (baked along with the type label text).
  if (!shellImg) {
    const [px, py, pw, ph] = ly.type_plaque_rect;
    const tinted = _resizedTintedCached(_assets.plaque, pw, ph, bannerHsv.h, bannerHsv.s, bannerHsv.v);
    ctx.drawImage(tinted, px, py);

    const typeText = _typeLabel(cfg);
    _setFont(ctx, 'bold', 30);
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(13,13,13,0.88)';
    const tw = _measureWidth(ctx, typeText);
    ctx.fillText(typeText, ((ly.card_w - tw) / 2) | 0, _yTop(30, py + (ph >> 1) - 19));
  }

  // 7) Description — wrap each \n-line to fit desc_max_width before drawing.
  {
    const raw = String(cfg.description || ' ').replace(/\\n/g, '\n');
    const wrapped = [];
    for (const rawLine of raw.split('\n')) {
      const segs    = _parseDescLine(rawLine);
      const tokens  = _tokenize(segs, ctx, 38);
      const subs    = _wrapTokens(tokens, ly.desc_max_width);
      if (subs.length === 0) wrapped.push({ tokens: [], width: 0 });  // preserve blank lines
      else for (const s of subs) wrapped.push(s);
    }
    const lines = wrapped.slice(0, 8);
    const blockTop = (ly.desc_center_y - ((lines.length - 1) * ly.desc_line_h) / 2) | 0;
    for (let i = 0; i < lines.length; i++) {
      _drawWrappedLine(ctx, lines[i], blockTop + i * ly.desc_line_h, 38, _descIconImage(cfg), _assets.star);
    }
  }

  // Composite inner card → outer canvas. Under shell, the outer canvas
  // already has every "inner" layer (drawn directly while a translation was
  // active); pop that translation so the outer-only passes below run in raw
  // canvas coordinates.
  if (shellImg) {
    cctx.restore();
  } else {
    cctx.drawImage(card, offx, offy);
    cctx.drawImage(bannerLayer, bannerX, bannerY);
  }

  if (energyLayer) {
    cctx.drawImage(energyLayer, energyX, energyY);

    _setFont(cctx, 'bold', 62);
    cctx.textBaseline = 'top';
    const fill   = cfg.cost_green ? 'rgba(127,255,0,1)'   : 'rgba(255,252,242,1)';
    const stroke = cfg.cost_green ? 'rgba(50,80,0,1)'     : 'rgba(97,59,26,1)';
    _drawTextWithStrokeShadow(
      cctx, costTx, _yTop(62, costTy), costText, fill, stroke, 6,
      { dx: 5, dy: 5, alpha: 0.30 },
    );
  }

  // 5b) Star cost — sits directly below the mana cost orb. Number ('X' or
  //     numeric) is overlaid using the same styling as the mana cost text.
  //     `-1` means "no star cost"; skip rendering. The icon is character-
  //     neutral so no HSV tint is applied.
  if (cfg.star_cost !== -1 && cfg.star_cost !== null && _assets.starCostIcon) {
    // Empirical -30/-30 nudge from "directly below the mana orb" — tucks the
    // star orb into the in-game position (overlapping the mana orb's lower-
    // right corner rather than sitting fully below it).
    const sx = offx + ly.energy_pos[0]                  - 30;
    const sy = offy + ly.energy_pos[1] + ly.energy_size - 30;
    cctx.drawImage(_assets.starCostIcon, sx, sy, ly.energy_size, ly.energy_size);

    // 20% smaller than the 62px mana cost. Vertical centering offset (was
    // -40 at 62px) scales proportionally so the text stays centered on the
    // icon at the new size.
    const starFontSize = 50;
    const starYAdjust  = Math.round(40 * starFontSize / 62);

    const sText = String(cfg.star_cost).slice(0, 2);
    _setFont(cctx, 'bold', starFontSize);
    cctx.textBaseline = 'top';
    const tw  = _measureWidth(cctx, sText);
    const stx = sx + (ly.energy_size >> 1) - (tw >> 1) - 3;
    const sty = sy + (ly.energy_size >> 1) - starYAdjust + ly.cost_y_offset;
    _drawTextWithStrokeShadow(
      cctx, stx, _yTop(starFontSize, sty), sText,
      'rgba(255,252,242,1)', 'rgba(97,59,26,1)', 6,
      { dx: 5, dy: 5, alpha: 0.30 },
    );
  }

  // 7.5) Ancient flame icon — sits at the horizontal center of the card,
  //      above the banner ribbon. Skipped silently when the asset isn't
  //      bundled (older render-asset bundles).
  if (isAncient && _assets.ancientFlame) {
    const flame = _assets.ancientFlame;
    const fw = flame.naturalWidth, fh = flame.naturalHeight;
    const fx = offx + ((ly.card_w - fw) >> 1);
    const fy = bannerY - (fh >> 1) + 4;  // perch on the top edge of the banner
    cctx.drawImage(flame, fx, fy);
  }

  // 8) Title (drawn last so it stays above the banner)
  {
    let title = String(cfg.card_name || 'Card').trim();
    if (cfg.upgraded) title += '+';
    _setFont(cctx, 'bold', 50);
    cctx.textBaseline = 'top';
    const tw = _measureWidth(cctx, title);
    const tx = offx + ((ly.card_w - tw) >> 1);
    const ty = offy + (isAncient ? ly.title_y_ancient : ly.title_y_normal);
    const fill = cfg.upgraded ? 'rgba(127,255,0,1)' : 'rgba(255,247,237,1)';
    _drawTextWithStrokeShadow(cctx, tx, _yTop(50, ty), title, fill, 'rgba(20,20,20,0.90)', 5);
  }

  return canvas;
}

// ── Shell pre-rendering ────────────────────────────────────────────────────
//
// A "shell" is a card-sized PNG containing every layer that DOESN'T change
// per save: frame (HSV-tinted by character), portrait border (HSV-tinted by
// rarity), banner (HSV-tinted by rarity), type plaque + type label. The
// portrait window is alpha-transparent so a runtime portrait drawn UNDER
// the shell shows through.
//
// Shells are keyed by (normalized character, card_type, rarity) — the only
// inputs the shell layers depend on. ~50 unique keys cover every card in
// the simplified set, so the on-disk cache is small.
//
// Ancient cards opt out of the shell path (their portrait masking is too
// per-card to bake into a generic shell), so renderShell short-circuits
// for ancient and the helper falls back to the full renderCard path.

function renderShell(cfgIn) {
  if (!_assets) throw new Error('renderer.preload() not awaited yet.');

  const cfg = _normalizeSpecialPool({
    card_type: String(cfgIn.card_type || 'skill').toLowerCase(),
    character: String(cfgIn.character || 'colorless').toLowerCase(),
    rarity:    String(cfgIn.rarity    || 'common').toLowerCase(),
  });

  const ly = LAYOUT;
  const isAncient = cfg.rarity === 'ancient';

  const canvas = _newCanvas(ly.out_w, ly.out_h);
  const cctx   = canvas.getContext('2d');
  const card   = _newCanvas(ly.card_w, ly.card_h);
  const ctx    = card.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const offx = ((ly.out_w - ly.card_w) >> 1) + ly.canvas_offset_x;
  const offy = ((ly.out_h - ly.card_h) >> 1) + ly.canvas_offset_y;

  const bannerHsv = BANNER_HSV[cfg.rarity] || BANNER_HSV.common;
  const frameHsv  = FRAME_HSV[cfg.rarity]
                 || FRAME_HSV[_charKey(cfg.character)]
                 || FRAME_HSV.ironclad;

  // Frame
  {
    const frameImg = _frameImage(cfg);
    const tinted   = _tintImageCached(frameImg, frameHsv.h, frameHsv.s, frameHsv.v);
    ctx.drawImage(tinted, 0, 0, ly.card_w, ly.card_h);
  }
  // Portrait border
  {
    const borderImg = _portraitBorderImage(cfg);
    if (borderImg) {
      const [bx, by, bw, bh] = ly.portrait_border_rect;
      const tinted = _resizedTintedCached(borderImg, bw, bh, bannerHsv.h, bannerHsv.s, bannerHsv.v);
      ctx.drawImage(tinted, bx, by);
    }
  }
  // Plaque + type label
  {
    const [px, py, pw, ph] = ly.type_plaque_rect;
    const tinted = _resizedTintedCached(_assets.plaque, pw, ph, bannerHsv.h, bannerHsv.s, bannerHsv.v);
    ctx.drawImage(tinted, px, py);

    const typeText = _typeLabel(cfg);
    _setFont(ctx, 'bold', 30);
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(13,13,13,0.88)';
    const tw = _measureWidth(ctx, typeText);
    ctx.fillText(typeText, ((ly.card_w - tw) / 2) | 0, _yTop(30, py + (ph >> 1) - 19));
  }

  cctx.drawImage(card, offx, offy);

  // Banner (drawn last on outer so the ribbon overhang isn't clipped).
  {
    const bImg = _bannerImage(cfg);
    const bannerH = isAncient ? ly.banner_h_ancient : ly.banner_h;
    const srcW = bImg.naturalWidth, srcH = bImg.naturalHeight;
    const bannerW = ((srcW * bannerH) / srcH * ly.banner_w_scale) | 0;
    const bannerLayer = isAncient
      ? _resizedTintedCached(bImg, bannerW, bannerH, 1.0, 1.0, 1.0)
      : _resizedTintedCached(bImg, bannerW, bannerH, bannerHsv.h, bannerHsv.s, bannerHsv.v);
    const bx = offx + ((ly.card_w - bannerW) >> 1);
    const by = offy + ly.banner_y_normal;
    cctx.drawImage(bannerLayer, bx, by);
  }

  return canvas;
}

// Compute the on-disk key for a given (character, type, rarity) tuple.
// Uses the same normalization as renderShell so curse/status/quest cards
// land on the right shell. Returns null if the rarity is one we don't shell
// (ancient).
function shellKey(character, type, rarity) {
  const cfg = _normalizeSpecialPool({
    character: String(character || 'colorless').toLowerCase(),
    card_type: String(type      || 'skill').toLowerCase(),
    rarity:    String(rarity    || 'common').toLowerCase(),
  });
  if (cfg.rarity === 'ancient') return null;
  return `${cfg.character}__${cfg.card_type}__${cfg.rarity}`;
}

// ── Exports ─────────────────────────────────────────────────────────────────

// ── cards.json adapter (folded in so the harness only loads one script) ────

// After the pipeline's cleanup step relocates extracted images into
// Assets/images/, card portraits live at appdata://images/cards/<color>/...
// The simplifier already prefixes imageFile with "cards/", so this base +
// the imageFile yields the right URL with no path mangling.
const PORTRAIT_BASE = 'appdata://images/';

// The frame is purely definitional — it always uses the card's own character.
// (Event-character cards fall through `_charKey` to the colorless/neutral
// frame, which is the right default given we can't currently distinguish
// "colorless events" like Mad Science from "character-flavored events" like
// Caltrops in the parser output.)
//
// The description's inline `[energy:N]` orbs follow the *deck owner* when a
// run context is supplied, otherwise the card's own character. This is the
// only place the renderer cares about run context.
function _resolveDescIconCharacter(rowChar, runContext) {
  if (runContext && runContext.character) return String(runContext.character).toLowerCase();
  const c = String(rowChar || '').toLowerCase();
  return c === 'the regent' ? 'regent' : c;
}

function adapt(row, { upgraded = false, runContext = null } = {}) {
  // An "upgraded" render only requires that the card is upgradable. If the
  // upstream parser produced no explicit upgrade text (true for ~100 cards
  // whose upgrade only changes cost/innate), `descriptionUpgraded` is empty
  // and we fall back to the base description — the cost and "+ name suffix
  // alone visually distinguish the upgraded variant.
  const useUpgraded = upgraded && row.canUpgrade;
  const description = useUpgraded
    ? (row.descriptionUpgraded || row.description)
    : row.description;
  const rawCost = useUpgraded
    ? (row.manaCostUpgraded != null ? row.manaCostUpgraded : row.manaCost)
    : row.manaCost;
  const cost = rawCost === -1 ? 'X' : String(rawCost);
  // Star cost: -1 = no star cost (passes through unchanged so the renderer
  // can skip drawing the orb). 'X' or N pass through verbatim — the
  // renderer stringifies them onto the icon.
  const starCost = useUpgraded
    ? (row.starCostUpgraded != null ? row.starCostUpgraded : row.starCost)
    : row.starCost;
  const portrait_url = row.imageFile ? PORTRAIT_BASE + row.imageFile : null;
  return {
    card_name:           row.name,
    description:         description || '',
    card_type:           String(row.type   || '').toLowerCase(),
    character:           String(row.character || '').toLowerCase(),
    desc_icon_character: _resolveDescIconCharacter(row.character, runContext),
    rarity:              String(row.rarity || '').toLowerCase(),
    cost,
    star_cost:           starCost,
    upgraded:            !!useUpgraded,
    cost_green:          false,
    portrait_url,
  };
}
function adaptAll(rows, opts) { return rows.map(r => adapt(r, opts)); }

// ── Exports ─────────────────────────────────────────────────────────────────

const _exports = {
  preload, renderCard, renderShell, shellKey,
  adapt, adaptAll, PORTRAIT_BASE,
  // exposed for unit tests / debugging
  _applyHsv, _buildHsvMatrix, _parseDescLine,
  BANNER_HSV, FRAME_HSV, LAYOUT,
};
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
if (typeof window !== 'undefined') {
  window.cardRender = window.cardRender || {};
  window.cardRender.renderer    = _exports;
  window.cardRender.dataAdapter = _exports;  // legacy alias — adapter folded in
  console.log('[card_render] renderer loaded');
}
