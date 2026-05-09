'use strict';
/**
 * card_render_helper.js — Bridges the dashboard UI's card placeholders to
 * the Canvas-2D renderer.
 *
 * The dashboard's renderer.js builds HTML strings synchronously, so we can't
 * inline a Canvas render at template time. Instead, every card emission site
 * outputs an <img> with `data-card-name`, `data-upgraded`, `data-build-id`,
 * and `data-deck-character` attributes plus a transparent placeholder src.
 * A MutationObserver finds those imgs after they're inserted and replaces
 * their src with a data-URL produced by the renderer.
 *
 * Caches rendered cards by (name, upgraded, buildId, runChar) to avoid re-
 * rendering the same card across multiple call sites.
 *
 * Inputs (assembled lazily on first hydrate):
 *   - cards.json from current simplified data (fetched via appdata://)
 *   - kernels bundle from electronAPI.getKernelsBundle()
 *   - renderer.preload() loads frame/banner/orb assets
 */

(() => {

const CACHE     = new Map();      // (name|upgraded|buildId|runChar) → data URL
const SNAP_CACHE = new Map();      // buildId → kernel-composed cards array
let   _ready    = false;
let   _readyP   = null;
let   _cards    = null;            // current simplified cards array
let   _kernels  = null;            // { 'kernels/foo.json': kernel-json }
let   _manifest = null;
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Shell layer cache. Strategy B: a shell PNG bakes the per-(character, type,
// rarity) frame/border/banner/plaque/type-label so the per-card render only
// has to draw portrait + cost orb + description + title on top, skipping
// every HSV pixel pass at runtime. Unknown keys fall through to the full
// renderCard path so missing shells never break rendering.
//   _shellOnDisk:  Set<key>          — keys we know have a baked PNG
//   _shellCache:   Map<key, Promise<HTMLImageElement|null>>  — load promises
//   _shellsBaking: Promise<void>|null — in-flight first-pass bake
const _shellOnDisk = new Set();
const _shellCache  = new Map();
let   _shellsBaking = null;

// Full card PNG cache. Strategy A: bake every (card, base|up[, rider]) into
// a complete PNG once, then runtime hydration becomes a plain `<img src>`
// that the browser handles natively. ZERO canvas / toDataURL / main-thread
// blocking at runtime — which also unblocks the relic-grid layout that's
// been suffering as collateral damage.
const _cardsOnDisk = new Set();
let   _cardsBaking = null;

// Output scale for baked PNGs. The renderer composes at 748×876 (full
// quality), but cards display at roughly 190×225 in the deck grid — 15×
// fewer pixels than rendered. We downscale before toDataURL so the on-
// disk PNGs are 374×438, still 2× supersampled for retina but ~4× faster
// to decode at runtime and ~4× smaller on disk. Kept as a constant so the
// trade-off is one place to tune.
const OUTPUT_SCALE = 0.8;
function _downscaleCanvas(canvas, scale) {
  if (scale === 1) return canvas;
  const w = Math.max(1, Math.round(canvas.width  * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

async function ensureReady() {
  if (_ready) return;
  if (_readyP) return _readyP;
  _readyP = (async () => {
    if (!window.cardRender || !window.cardRender.renderer) {
      throw new Error('card_render_helper: window.cardRender.renderer missing — load order issue?');
    }
    await window.cardRender.renderer.preload();

    // Current simplified cards. `appdata://data/` is wired in main.js.
    try {
      const r = await fetch('appdata://data/cards.json');
      _cards = r.ok ? await r.json() : [];
    } catch (_) { _cards = []; }

    // Kernel bundle (finalized + remote-cached, deduped in main.js).
    try {
      const b = await window.electronAPI.getKernelsBundle();
      _kernels  = b.kernels  || {};
      _manifest = b.manifest || null;
    } catch (_) { _kernels = {}; _manifest = null; }

    // Seed the shell-on-disk set so the per-render fast path can short-
    // circuit the bake check. Missing shells are filled in lazily below.
    try {
      const keys = await window.electronAPI.listCardShells();
      for (const k of keys || []) _shellOnDisk.add(k);
    } catch (_) {}

    // Seed the card-PNG-on-disk set. Strategy A's runtime is "img src =
    // appdata://images/cards/<key>.png" with zero JS work — but we need
    // to know which keys are actually on disk before pointing imgs at them.
    try {
      const keys = await window.electronAPI.listCardPngs();
      for (const k of keys || []) _cardsOnDisk.add(k);
    } catch (_) {}

    _ready = true;
  })();
  // Shells are still safe to bake lazily — they don't need card portraits,
  // only the bundled card-render assets that ship with the app. The full
  // card bake is now pipeline-driven (runPipelineBake) because card
  // portraits live only in the extraction dir during pipeline runs.
  _readyP.then(() => bakeMissingShells());
  return _readyP;
}

// Background shell bake. Walks the unique (character, type, rarity) tuples
// in the current card set, renders any whose key isn't already on disk, and
// streams them to main for persistence. Card renders triggered while this
// is running may miss the shell and fall back to the slow path; subsequent
// renders pick up the shell once it lands. Fire-and-forget — exceptions
// are logged but never bubble up.
async function bakeMissingShells() {
  if (_shellsBaking) return _shellsBaking;
  _shellsBaking = (async () => {
    if (!_cards || !window.cardRender || !window.cardRender.renderer) return;
    const renderer = window.cardRender.renderer;
    const wanted = new Set();
    for (const c of _cards) {
      const k = renderer.shellKey(c.character, c.type, c.rarity);
      if (k) wanted.add(k);
      // Mad Science variants drop into 3 different (type) buckets; bake
      // shells for each post-variant type so all 9 riders find a shell.
      if (c.typeVariants) {
        for (const v of Object.values(c.typeVariants)) {
          if (!v) continue;
          const vk = renderer.shellKey(c.character, v.type, c.rarity);
          if (vk) wanted.add(vk);
        }
      }
    }

    const todo = [...wanted].filter(k => !_shellOnDisk.has(k));
    if (todo.length === 0) {
      console.log(`[card_render] all ${wanted.size} shells cached`);
      return;
    }
    console.log(`[card_render] baking ${todo.length} new shells (${wanted.size} total)`);

    for (const key of todo) {
      try {
        const [character, card_type, rarity] = key.split('__');
        const canvas = renderer.renderShell({ character, card_type, rarity });
        const dataUrl = canvas.toDataURL('image/png');
        const base64  = dataUrl.split(',', 2)[1] || '';
        const ok = await window.electronAPI.saveCardShell(key, base64);
        if (ok) {
          _shellOnDisk.add(key);
          // Drop any cached load promise for this key — the next request
          // will hit the now-on-disk file fresh.
          _shellCache.delete(key);
        }
      } catch (e) {
        console.warn('[card_render] shell bake failed:', key, e);
      }
      // Yield between bakes — each renderShell + toDataURL is synchronous
      // (~100ms), so without this the UI stalls for the full bake cycle.
      await new Promise(r => setTimeout(r, 0));
    }
    console.log(`[card_render] shell bake done`);
  })().catch((e) => {
    console.error('[card_render] shell bake threw:', e);
  });
  return _shellsBaking;
}

// Lazy shell loader. Returns null if the shell isn't on disk (caller falls
// back to renderCard). Caches the load promise so repeat hits across a deck
// only fetch once per session.
function _loadShell(key) {
  if (!key || !_shellOnDisk.has(key)) return Promise.resolve(null);
  const hit = _shellCache.get(key);
  if (hit) return hit;
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => { _shellOnDisk.delete(key); _shellCache.delete(key); resolve(null); };
    img.src = `appdata://shells/${encodeURIComponent(key)}.png`;
  });
  _shellCache.set(key, p);
  return p;
}

// ── Snapshot composition for save-based rendering ───────────────────────────

function _snapshotForBuild(buildId) {
  if (!buildId || !_manifest || !_manifest.current_version || buildId === _manifest.current_version) {
    return _cards;
  }
  if (SNAP_CACHE.has(buildId)) return SNAP_CACHE.get(buildId);
  if (!window.kernelComposer) return _cards;
  const { snapshot } = window.kernelComposer.composeSnapshot({
    currentData:    { cards: _cards, relics: [], enchantments: [] },
    currentVersion: _manifest.current_version,
    targetVersion:  buildId,
    kernels:        _kernels,
  });
  SNAP_CACHE.set(buildId, snapshot.cards);
  return snapshot.cards;
}

// ── Per-card render ─────────────────────────────────────────────────────────

// Per-URL portrait cache. The browser caches the underlying bytes, but
// constructing a fresh `new Image()` and waiting for its `load` event still
// adds 5-30ms per card — noticeable across a 30-card deck. Cache the
// resolved HTMLImageElement so repeat hits return immediately.
const _portraitCache = new Map();
function _loadPortrait(url) {
  if (!url) return Promise.resolve(null);
  const hit = _portraitCache.get(url);
  if (hit) return hit;
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => { _portraitCache.delete(url); resolve(null); };
    img.src = url;
  });
  _portraitCache.set(url, p);
  return p;
}

async function _renderToDataUrl(name, { upgraded = false, buildId = null, runChar = null, character = null, tinkerRider = null } = {}) {
  const cards = _snapshotForBuild(buildId);
  // Pick the variant matching `character` first (Strike/Defend disambiguation),
  // fall back to the generic name lookup so non-basic cards still resolve.
  const wantChar = character ? character.toLowerCase() : null;
  let row = null;
  if (wantChar) {
    row = (cards || []).find(c => c.name === name && (c.character || '').toLowerCase() === wantChar)
       || (cards || []).find(c => normalizeName(c.name) === normalizeName(name) && (c.character || '').toLowerCase() === wantChar);
  }
  if (!row) {
    row = (cards || []).find(c => c.name === name)
       || (cards || []).find(c => normalizeName(c.name) === normalizeName(name));
  }
  if (!row) return null;

  // Multi-type cards (Mad Science): the simplifier preserves a `typeVariants`
  // map keyed by lowercase type. The save records which 0..8 variant the
  // player got via TinkerTimeRider; values 0-2 are attack, 3-5 skill, 6-8
  // power, with the modulus picking among each type's three riders. Override
  // the row's type/imageFile/description so the canvas pipeline draws the
  // exact variant on the card.
  if (tinkerRider != null && row.typeVariants) {
    row = _applyTinkerVariant(row, tinkerRider);
  }

  const adapter = window.cardRender.renderer;
  const cfg = adapter.adapt(row, {
    upgraded,
    runContext: runChar ? { character: runChar } : null,
  });
  // Portrait load + shell load run in parallel — both are I/O. Shell is
  // null when not yet baked; renderCard handles that by falling back to
  // the full HSV pipeline.
  const shellK = adapter.shellKey ? adapter.shellKey(cfg.character, cfg.card_type, cfg.rarity) : null;
  const [portrait, shell] = await Promise.all([
    _loadPortrait(cfg.portrait_url),
    _loadShell(shellK),
  ]);
  cfg.portrait_image = portrait;
  const canvas = adapter.renderCard(cfg, shell);
  // Match the bake's output scale so canvas-fallback and disk PNGs render
  // at the same effective resolution — keeps cache hits and misses
  // visually consistent.
  const out = _downscaleCanvas(canvas, OUTPUT_SCALE);
  return out.toDataURL('image/png');
}

const TINKER_TYPE_ORDER = ['attack', 'skill', 'power'];
function _applyTinkerVariant(row, riderIdx) {
  const i = riderIdx | 0;
  if (i < 0 || i > 8) return row;
  const typeKey = TINKER_TYPE_ORDER[Math.floor(i / 3)];
  const localRider = i % 3;
  const variant = row.typeVariants && row.typeVariants[typeKey];
  if (!variant) return row;
  const rider = (variant.riders || [])[localRider] || null;
  // Compose the variant body: variant base text + rider effect.
  // Power's variant.description is "" — rider description carries the whole
  // body in that case, which the join skips cleanly.
  const parts = [];
  if (variant.description) parts.push(variant.description);
  if (rider && rider.description) parts.push(rider.description);
  const variantBody = parts.join('\n');

  // Carry over keyword wraps from the parent row's description /
  // descriptionUpgraded. The simplifier already wrapped each keyword
  // (Innate, Exhaust, Ethereal, …) as "[gold]Name.[/gold]" lines before
  // / after the row's body text. Mad Science's upgrade adds Innate to
  // ALL 9 variants — that keyword is on row.descriptionUpgraded but
  // would otherwise be dropped here. Same logic for any base keywords.
  const baseKw = _extractKeywordWraps(row.description);
  const upKw   = _extractKeywordWraps(row.descriptionUpgraded);
  const compose = (kw, body) => {
    const out = [];
    if (kw.before.length) out.push(kw.before.join('\n'));
    if (body)             out.push(body);
    if (kw.after.length)  out.push(kw.after.join('\n'));
    return out.join('\n');
  };

  return {
    ...row,
    type:                variant.type || row.type,
    description:         compose(baseKw, variantBody),
    descriptionUpgraded: compose(upKw,   variantBody),
    imageFile:           variant.imageFile || row.imageFile,
  };
}

// Pull the standalone "[gold]Keyword.[/gold]" lines out of a description.
// Lines BEFORE the first body line go in `before`; lines AFTER go in
// `after`. Matches the layout produced by the simplifier's injectKeywords
// (Innate / Unplayable above body, Exhaust / Retain / Ethereal / Eternal /
// Sly below body).
function _extractKeywordWraps(text) {
  const lines = String(text || '').split('\n');
  const re = /^\s*\[gold\]\w+\.\[\/gold\]\s*$/;
  const before = [], after = [];
  let inBody = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (re.test(trimmed)) {
      (inBody ? after : before).push(trimmed);
    } else {
      inBody = true;
    }
  }
  return { before, after };
}

function normalizeName(s) {
  return String(s || '').toLowerCase()
    .replace(/[()'']/g, '').replace(/[-_\/]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Disk key for a card-PNG bake / lookup. Built from the same fields as
// _cacheKey but with filesystem-safe sanitization. Bake and runtime use
// this same function so keys always agree.
function _cardDiskKey(character, name, upgraded, tinkerRider) {
  if (!character || !name) return null;
  const char = String(character).toLowerCase().replace(/[^a-z]/g, '');
  const nm   = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!char || !nm) return null;
  let key = `${char}__${nm}__${upgraded ? 'up' : 'base'}`;
  if (tinkerRider != null) key += `__r${tinkerRider}`;
  return key;
}

// Filesystem-safe form of a build version string (e.g. "v0.99.1").
function _versionSafe(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// Resolve disk-PNG availability for a given placeholder.
//
// Strategy (no kernels at runtime — kernels are only used at bake time
// to figure out WHICH versions need PNGs):
//   1. Bake produces one PNG per distinct state of a card, labeled with
//      the OLDEST version where that state begins.
//   2. Runtime: for save at buildId V, find the largest baked version
//      ≤ V in chronological order. That's the right PNG — the state at
//      V matches the state at that bake's label (no later kernel touches
//      the card between bake-label and V).
//   3. If no versioned PNG ≤ V exists, the card was never kernel-touched
//      in this chain, so its current data IS its data at V. Use base.
//
// Version comparison uses the manifest's `versions` array as the
// chronological ordering — index lookup, no kernel walk.
let _versionList = null;
let _versionIndexMap = null;
function _ensureVersionMap() {
  if (_versionIndexMap) return;
  if (!_manifest || !Array.isArray(_manifest.versions)) return;
  _versionList = _manifest.versions.map(v => v.version);
  if (_manifest.current_version
      && _versionList[_versionList.length - 1] !== _manifest.current_version) {
    _versionList.push(_manifest.current_version);
  }
  _versionIndexMap = new Map();
  _versionList.forEach((v, i) => _versionIndexMap.set(v, i));
}

// Multi-variant cards (Mad Science) need a rider 0..8 to find a baked
// PNG. Saves missing the TinkerTimeRider prop, OR carrying an out-of-
// range value (older save formats / data corruption), would otherwise
// resolve to a non-existent disk key. Default such cards to rider 0
// (attack/sapping) so they still render with SOMETHING reasonable.
function _normalizeTinkerRider(opts) {
  let rider = opts.tinkerRider;
  const inRange = typeof rider === 'number' && rider >= 0 && rider <= 8;
  if (inRange) return rider;
  if (!_cards) return rider;       // can't tell if card has typeVariants yet
  const wantChar = (opts.character || '').toLowerCase();
  const row = _cards.find(c => c.name === opts.name
    && (!wantChar || (c.character || '').toLowerCase() === wantChar));
  if (row && row.typeVariants) return 0;
  return rider;
}

function _diskCardUrl(opts) {
  if (!_ready) return null;
  const tinkerRider = _normalizeTinkerRider(opts);
  const baseKey = _cardDiskKey(opts.character, opts.name, opts.upgraded, tinkerRider);
  if (!baseKey) return null;

  const baseUrl = () => _cardsOnDisk.has(baseKey)
    ? `appdata://images/cards/${encodeURIComponent(baseKey)}.png`
    : null;

  // Current save → base PNG (= current data).
  if (!opts.buildId || !_manifest || !_manifest.current_version
      || opts.buildId === _manifest.current_version) {
    return baseUrl();
  }

  _ensureVersionMap();
  if (!_versionIndexMap) return baseUrl();

  const targetIdx = _versionIndexMap.get(opts.buildId);
  if (targetIdx == null) return baseUrl();   // unknown buildId — best-effort

  // Walk from target down to oldest. First baked versioned PNG wins —
  // it represents the largest baked version ≤ target.
  for (let i = targetIdx; i >= 0; i--) {
    const ver = _versionList[i];
    const vKey = `${baseKey}__v${_versionSafe(ver)}`;
    if (_cardsOnDisk.has(vKey)) {
      return `appdata://images/cards/${encodeURIComponent(vKey)}.png`;
    }
  }
  // No versioned PNG ≤ target: card was never kernel-touched in this
  // range, so its current data is also its data at buildId.
  return baseUrl();
}

// Build the bake-target list for a single card snapshot, optionally tagged
// with a buildId suffix when this is a kernel-composed older-version
// variant. Pushed entries land in the bake queue downstream.
function _addCardBakeTargets(wanted, c, buildVersion) {
  const vSuffix = buildVersion ? `__v${_versionSafe(buildVersion)}` : '';
  const push = (upgraded, rider) => {
    const baseKey = _cardDiskKey(c.character, c.name, upgraded, rider);
    if (!baseKey) return;
    wanted.push({ row: c, upgraded, rider, key: baseKey + vSuffix, buildVersion });
  };
  if (c.typeVariants) {
    // Mad Science: 9 rider variants × (base + maybe upgraded).
    for (let r = 0; r < 9; r++) {
      push(false, r);
      if (c.canUpgrade) push(true, r);
    }
  } else {
    push(false, null);
    if (c.canUpgrade) push(true, null);
  }
}

// Background full-card bake. Walks every simplified card and renders each
// (base, upgraded[, Mad Science rider]) into a PNG saved under
// <userData>/Assets/cards-rendered/. Then walks each kernel's `to` version
// and bakes versioned variants (`__v<buildId>`) for cards whose data
// differs from current — so old saves render their period-accurate stats
// from disk PNGs too, no canvas at runtime.
//
// Options:
//   progressCb  — called after each bake with { done, total }. Used by
//                 the [render] stage to update the pipeline overlay.
//
// Portraits load via the renderer's default `appdata://images/cards/...`
// base — the [relocate] pipeline stage moves them there before [render]
// fires, and they're wiped after the bake completes.
//
// Yields between bakes so the UI stays responsive. Idempotent — only
// renders keys not already on disk.
async function bakeMissingCards({ progressCb = null } = {}) {
  if (_cardsBaking) return _cardsBaking;
  _cardsBaking = (async () => {
    console.log('[card_render] bakeMissingCards: entering, _cards=' + (_cards ? _cards.length : 'null')
                + ' window.cardRender=' + (typeof window.cardRender)
                + ' renderer=' + (window.cardRender && typeof window.cardRender.renderer));
    if (!_cards || !window.cardRender || !window.cardRender.renderer) {
      console.warn('[card_render] bakeMissingCards: bailing — missing dependency. _cards=' + (_cards ? _cards.length : 'null')
                   + ' cardRender=' + (typeof window.cardRender)
                   + ' renderer=' + (window.cardRender && typeof window.cardRender.renderer));
      _cardsBakeResult = { baked: 0, totalKeys: 0, error: 'missing _cards or window.cardRender.renderer' };
      return;
    }
    const renderer = window.cardRender.renderer;

    // 1) CURRENT data. One bake target per (card, base/up, rider).
    const wanted = [];
    for (const c of _cards) _addCardBakeTargets(wanted, c, null);
    console.log('[card_render] bake: ' + wanted.length + ' current keys queued from ' + _cards.length + ' cards');

    // 2) STATE RUNS PER CARD. For each card touched by any kernel, we
    // identify its distinct state runs across the version timeline and
    // bake one PNG per run, labeled with the OLDEST version of that run.
    // Runtime then does a simple "largest baked version ≤ target" lookup
    // (no kernel walk). Concretely, for each card with N touching kernels
    // (sorted by k.to chronologically), we bake N PNGs:
    //   run i = state at k_i.to, oldest version of run = k_{i-1}.from
    //           (or oldest known version when i = 0)
    // The current state (run after the newest touching kernel) is the
    // base PNG — already baked above.
    if (_manifest && Array.isArray(_manifest.versions) && _manifest.current_version) {
      // Chronological version list with indexer.
      const verList = _manifest.versions.map(v => v.version);
      if (verList[verList.length - 1] !== _manifest.current_version) {
        verList.push(_manifest.current_version);
      }
      const verIdx = new Map();
      verList.forEach((v, i) => verIdx.set(v, i));

      // Group touching kernels by card.
      const byCard = new Map();   // cardName → [kernels]
      for (const k of Object.values(_kernels || {})) {
        if (!k || !k.to || !k.cards) continue;
        for (const cardName of Object.keys(k.cards)) {
          if (cardName === '_source') continue;
          const fields = Object.entries(k.cards[cardName]).filter(([f]) => f !== '_source');
          if (fields.length === 0) continue;
          if (!byCard.has(cardName)) byCard.set(cardName, []);
          byCard.get(cardName).push(k);
        }
      }

      let kernelChangeCount = 0;
      for (const [cardName, ks] of byCard.entries()) {
        // Sort touching kernels by k.to chronologically (oldest first).
        ks.sort((a, b) => (verIdx.get(a.to) ?? 0) - (verIdx.get(b.to) ?? 0));

        for (let i = 0; i < ks.length; i++) {
          const k = ks[i];
          const oldestVer = i === 0
            ? verList[0]                  // first run reaches back to oldest known
            : ks[i - 1].from;             // next run starts at the previous transition's `from`
          const snap = _snapshotForBuild(k.to);
          if (!Array.isArray(snap)) continue;
          const c = snap.find(x => x && x.name === cardName);
          if (!c) continue;               // entity didn't exist at this version
          _addCardBakeTargets(wanted, c, oldestVer);
          kernelChangeCount++;
        }
      }
      if (kernelChangeCount > 0) {
        console.log(`[card_render] state runs from kernels: ${kernelChangeCount}`);
      }
    }

    const todo = wanted.filter(w => !_cardsOnDisk.has(w.key));
    if (todo.length === 0) {
      console.log(`[card_render] all ${wanted.length} card PNGs cached`);
      if (progressCb) progressCb({ done: 0, total: 0, baked: 0, totalKeys: wanted.length });
      _cardsBakeResult = { baked: 0, totalKeys: wanted.length };
      return;
    }
    console.log(`[card_render] baking ${todo.length} card PNGs (${wanted.length} total)`);

    let i = 0, baked = 0, saveFails = 0, renderFails = 0, portraitFails = 0;
    if (progressCb) progressCb({ done: 0, total: todo.length });
    for (const t of todo) {
      try {
        let row = t.row;
        if (t.rider != null && row.typeVariants) row = _applyTinkerVariant(row, t.rider);
        const cfg = renderer.adapt(row, { upgraded: t.upgraded });
        const shellK = renderer.shellKey(cfg.character, cfg.card_type, cfg.rarity);
        const [portrait, shell] = await Promise.all([
          _loadPortrait(cfg.portrait_url),
          _loadShell(shellK),
        ]);
        if (!portrait) portraitFails++;
        cfg.portrait_image = portrait;
        const canvas  = renderer.renderCard(cfg, shell);
        const out     = _downscaleCanvas(canvas, OUTPUT_SCALE);
        const dataUrl = out.toDataURL('image/png');
        const base64  = dataUrl.split(',', 2)[1] || '';
        if (!base64) { renderFails++; continue; }
        const ok = await window.electronAPI.saveCardPng(t.key, base64);
        if (ok) { _cardsOnDisk.add(t.key); baked++; }
        else    { saveFails++; if (saveFails <= 3) console.warn('[card_render] saveCardPng returned false for key:', t.key); }
      } catch (e) {
        renderFails++;
        if (renderFails <= 3) console.warn('[card_render] card bake threw for', t.key, ':', e);
      }
      i++;
      if (progressCb && (i % 5 === 0 || i === todo.length)) {
        progressCb({ done: i, total: todo.length });
      }
      // Yield every few bakes so the main thread can paint. Each bake is
      // ~50-100ms; we don't want a 60-second pause for the UI.
      if ((i % 3) === 0) await new Promise(r => setTimeout(r, 0));
    }
    console.log(`[card_render] card bake done — baked=${baked} renderFails=${renderFails} saveFails=${saveFails} portraitFails=${portraitFails}`);
    _cardsBakeResult = { baked, totalKeys: wanted.length, renderFails, saveFails, portraitFails };
  })().catch((e) => {
    console.error('[card_render] card bake threw:', e);
    _cardsBakeResult = { baked: 0, totalKeys: 0, error: e.message || String(e) };
  });
  return _cardsBaking;
}

// Last-bake result so the pipeline trigger can report back to main.
let _cardsBakeResult = { baked: 0, totalKeys: 0 };

// Pipeline entry point. Called from renderer.js when main sends
// `pipeline-bake-cards-trigger`. Resets the helper, awaits ensureReady (so
// freshly-pipelined data is loaded), then runs both shell + card bakes to
// completion in pipeline mode (portraits read from extracted://). Returns
// the bake summary so the main process can log it.
async function runPipelineBake(progressCb) {
  // Awaited wipe of stale disk PNGs — data may have changed since last
  // pipeline run. MUST complete before the bake starts writing, or we'd
  // race against deletion of the freshly-saved PNGs.
  if (window.electronAPI && window.electronAPI.clearCardPngs) {
    try { await window.electronAPI.clearCardPngs(); } catch (_) {}
  }
  reload();
  await ensureReady();
  await bakeMissingShells();
  await bakeMissingCards({ progressCb });
  return _cardsBakeResult;
}

// ── DOM hydration ───────────────────────────────────────────────────────────

function _cacheKey(name, opts) {
  return `${name}|${!!opts.upgraded}|${opts.buildId || ''}|${opts.runChar || ''}|${opts.character || ''}|${opts.tinkerRider ?? ''}`;
}

function _readImgOpts(img) {
  const riderRaw = img.dataset.tinkerRider;
  return {
    name:        img.dataset.cardName || '',
    upgraded:    img.dataset.upgraded === 'true',
    buildId:     img.dataset.buildId || null,
    runChar:     img.dataset.deckCharacter || null,
    character:   img.dataset.cardCharacter || null,  // Strike/Defend variant pin
    tinkerRider: (riderRaw != null && riderRaw !== '') ? parseInt(riderRaw, 10) : null,
  };
}

async function hydrateOne(img) {
  return hydrateBatch([img]);
}

// Hydrate a set of placeholder <img> elements. Three resolution paths in
// priority order:
//   1. In-memory data-URL cache (CACHE) — instant.
//   2. Pre-baked card PNG on disk (Strategy A) — sets src to an
//      appdata://images/cards/<key>.png URL. Browser handles the
//      load natively. Zero JS work, zero main-thread block.
//   3. Canvas fallback for kernel-composed snapshots and cards that
//      haven't been baked yet — renders on the main thread, batched so
//      misses reveal together rather than trickling in.
async function hydrateBatch(imgs) {
  if (!imgs || imgs.length === 0) return;

  const misses = [];
  for (const img of imgs) {
    if (img.dataset.cardRendered === '1') continue;
    img.dataset.cardRendered = 'pending';
    const opts = _readImgOpts(img);
    if (!opts.name) { img.dataset.cardRendered = '1'; continue; }

    // 1) In-memory cache.
    const key = _cacheKey(opts.name, opts);
    const cached = CACHE.get(key);
    if (cached) {
      img.src = cached;
      img.dataset.cardRendered = '1';
      continue;
    }

    // 2) Disk PNG (Strategy A). _diskCardUrl returns null when the data
    // isn't loaded yet, the buildId triggers kernel composition, or the
    // key hasn't been baked — all of which fall through to the canvas
    // path.
    const diskUrl = _diskCardUrl(opts);
    if (diskUrl) {
      img.src = diskUrl;
      img.dataset.cardRendered = '1';
      continue;
    }

    misses.push({ img, opts, key });
  }

  if (misses.length === 0) return;

  await ensureReady();

  // After ensureReady resolves we know the manifest is loaded; recheck
  // the disk path for misses that were rejected because _ready was
  // still false on the synchronous pass.
  const stillMissing = [];
  for (const m of misses) {
    const diskUrl = _diskCardUrl(m.opts);
    if (diskUrl) {
      m.img.src = diskUrl;
      m.img.dataset.cardRendered = '1';
    } else {
      stillMissing.push(m);
    }
  }
  if (stillMissing.length === 0) return;

  // No canvas at runtime: the dashboard's design is "all card PNGs are
  // produced at pipeline time, runtime just <img src> them." If we end
  // up here it means a PNG is missing on disk — a pipeline bug, not a
  // runtime case to paper over. Leave the placeholder gif as the src
  // and log loudly so it surfaces.
  for (const m of stillMissing) {
    m.img.dataset.cardRendered = '1';
    console.warn('[card_render] no disk PNG for', m.key,
      '→ pipeline bake didn\'t produce this. Re-run Update Resources.');
  }
}

function hydrateAll(root = document) {
  const imgs = root.querySelectorAll('img[data-card-name]:not([data-card-rendered="1"])');
  return hydrateBatch([...imgs]);
}

// Auto-hydrate on DOM mutations.
function _setupAutoHydrate() {
  const obs = new MutationObserver((muts) => {
    let any = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (n.matches?.('img[data-card-name]') ||
              n.querySelector?.('img[data-card-name]:not([data-card-rendered="1"])')) {
            any = true; break;
          }
        }
      }
      if (any) break;
    }
    if (any) hydrateAll();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  hydrateAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _setupAutoHydrate);
} else {
  _setupAutoHydrate();
}

// Force a full reload — clears the data caches AND the ready flag so the
// next render call re-fetches cards.json + kernels. Call this after the
// pipeline finishes so the helper picks up freshly-extracted data instead
// of whatever it loaded on first launch.
function reload() {
  CACHE.clear();
  SNAP_CACHE.clear();
  _shellCache.clear();
  // Drop the in-memory snapshot of which PNGs are on disk; ensureReady
  // re-fetches it on next access. CRITICAL: do NOT wipe the disk PNGs
  // here — reload() runs after every pipeline run (called from
  // loadAssetData), which would erase the bake we just produced. Disk
  // wipe lives in runPipelineBake, where it belongs (clean slate
  // immediately before re-baking).
  _cardsOnDisk.clear();
  // Same logic for shells — they're fine to reuse across reloads.
  _shellsBaking = null;
  _cardsBaking  = null;
  _versionList     = null;
  _versionIndexMap = null;
  _ready  = false;
  _readyP = null;
  _cards  = null;
  _kernels  = null;
  _manifest = null;
}

// Diagnostic API for tracing disk-PNG resolution. Tells you exactly
// which baked PNG (if any) the helper would pick for a given placeholder
// without actually rendering. Usage from DevTools:
//   cardRenderHelper.debugDiskUrl('Untouchable', { character: 'Silent', buildId: 'v0.99.1' })
async function debugDiskUrl(name, opts = {}) {
  await ensureReady();
  const character = opts.character || 'Silent';
  const upgraded  = !!opts.upgraded;
  const tinkerRider = opts.tinkerRider ?? null;
  const buildId   = opts.buildId || null;

  const baseKey = _cardDiskKey(character, name, upgraded, tinkerRider);
  console.log('=== debugDiskUrl ===');
  console.log('inputs:', { name, character, upgraded, tinkerRider, buildId });
  console.log('baseKey:', baseKey);
  console.log('_manifest.current_version:', _manifest && _manifest.current_version);
  console.log('_cardsOnDisk size:', _cardsOnDisk.size);
  console.log('  base on disk?', _cardsOnDisk.has(baseKey));

  // Current save → base PNG.
  const isCurrent = !buildId || !_manifest || !_manifest.current_version || buildId === _manifest.current_version;
  if (isCurrent) {
    console.log('isCurrent → return base PNG');
    return baseKey;
  }

  // Walk down the chronological version list, logging every step.
  _ensureVersionMap();
  if (!_versionIndexMap) {
    console.log('no version map available → fallback to base');
    return baseKey;
  }
  const targetIdx = _versionIndexMap.get(buildId);
  if (targetIdx == null) {
    console.log('buildId ' + buildId + ' not in manifest.versions → fallback to base');
    return baseKey;
  }
  console.log('walk-down (target index ' + targetIdx + '):');
  for (let i = targetIdx; i >= 0; i--) {
    const ver = _versionList[i];
    const vKey = `${baseKey}__v${_versionSafe(ver)}`;
    const onDisk = _cardsOnDisk.has(vKey);
    console.log('  i=' + i + ' ver=' + ver + ' → vKey=' + vKey + ' → on disk: ' + onDisk);
    if (onDisk) {
      console.log('  HIT — would use this PNG');
      return vKey;
    }
  }
  console.log('no versioned PNG ≤ target → falls back to base PNG (' + (_cardsOnDisk.has(baseKey) ? 'on disk' : 'MISSING') + ')');
  return baseKey;
}

// Diagnostic API for debugging kernel composition from DevTools. Usage:
//   await cardRenderHelper.debugRender('Untouchable', { buildId: 'v0.99.1' })
async function debugRender(name, opts = {}) {
  await ensureReady();
  console.log('helper state:',
    'manifest.current_version =', _manifest?.current_version,
    '| kernels =', Object.keys(_kernels || {}).length,
    '| cards =', _cards?.length,
    '| window.kernelComposer =', typeof window.kernelComposer,
    '| SNAP_CACHE has', opts.buildId, ':', SNAP_CACHE.has(opts.buildId));

  // Probe: is the kernel for the target's `from` actually loaded? Walk
  // backward from current to target and report each step.
  if (opts.buildId && _manifest?.current_version && opts.buildId !== _manifest.current_version) {
    const byFrom = new Map();
    for (const k of Object.values(_kernels || {})) if (k && k.from) byFrom.set(k.from, k);
    let cursor = _manifest.current_version;
    const path = [];
    while (cursor && cursor !== opts.buildId) {
      const k = byFrom.get(cursor);
      if (!k) { path.push(`✗ no kernel from ${cursor}`); break; }
      const u = k.cards && k.cards[name];
      path.push(`${k.from} → ${k.to}${u ? '  [' + Object.keys(u).filter(x => x !== '_source').join(',') + ']' : ''}`);
      cursor = k.to;
    }
    console.log('kernel chain:');
    for (const p of path) console.log('   ' + p);
  }

  // Force a fresh compose, ignoring SNAP_CACHE so a stale entry can't lie
  // to us. (Restores the cache afterward so we don't interfere with live
  // rendering unintentionally.)
  const cached = SNAP_CACHE.get(opts.buildId);
  SNAP_CACHE.delete(opts.buildId);
  const snap = _snapshotForBuild(opts.buildId || null);
  if (cached !== undefined) SNAP_CACHE.set(opts.buildId, cached);
  const row = snap.find(c => c.name === name);
  console.log(`fresh compose, row for ${name} @ ${opts.buildId || 'current'}:`, row);
  return row;
}

// Public surface — the dashboard renderer.js can also force-hydrate after
// large innerHTML updates to skip the MutationObserver round-trip.
window.cardRenderHelper = {
  PLACEHOLDER,
  hydrateAll,
  hydrateOne,
  hydrateBatch,
  ensureReady,
  reload,
  debugRender,
  debugDiskUrl,
  runPipelineBake,
  invalidateCache: () => { CACHE.clear(); SNAP_CACHE.clear(); },
};

})();
