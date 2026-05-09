'use strict';
/**
 * kernel_composer.js — Reconstruct period-accurate cards / relics /
 * enchantments for a save played at an older version, by walking backward-
 * delta kernels.
 *
 * INPUT
 *   currentData       { cards, relics, enchantments }   arrays from simplifier
 *   currentVersion    string                            e.g. "v0.104.0"
 *   targetVersion     string                            save's build_id
 *   kernels           { <key>: kernel-json, ... }       finalized kernels
 *
 * OUTPUT
 *   { snapshot, reachedTarget, walkedThrough, missing }
 *     snapshot       same shape as currentData, mutated to target version
 *     reachedTarget  bool — true if we walked all the way; false if chain broke
 *     walkedThrough  array of "from→to" pairs actually applied
 *     missing        array of expected "from→to" steps that had no kernel
 *
 * Each kernel reverts FROM its `from` (newer) TO its `to` (older). Each entry
 * lists only the fields that changed, as `{ old, new }` pairs. Backward apply
 * sets every field to its `old` value. `old: null` for every field of an
 * entity = the entity did not exist at `to` and is removed from the snapshot.
 *
 * No-kernel-found case: stop walking, return what we have. Per spec, partial-
 * fidelity is preferred to no rendering at all.
 */

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {{cards:any[],relics:any[],enchantments:any[]}} args.currentData
 * @param {string} args.currentVersion
 * @param {string} args.targetVersion
 * @param {Record<string, any>} args.kernels
 * @returns {{snapshot:any, reachedTarget:boolean, walkedThrough:string[], missing:string[]}}
 */
function composeSnapshot({ currentData, currentVersion, targetVersion, kernels }) {
  const snapshot = _deepClone(currentData);
  const walkedThrough = [];
  const missing = [];

  // Identity short-circuit: the save was played at the same version we have
  // current data for. Nothing to revert.
  if (!targetVersion || targetVersion === currentVersion) {
    return { snapshot, reachedTarget: true, walkedThrough, missing };
  }

  // Index kernels by their `from` version so we can pick the correct one to
  // unwind at each step.
  const byFrom = new Map();
  for (const k of Object.values(kernels || {})) {
    if (k && typeof k === 'object' && k.from) byFrom.set(k.from, k);
  }

  // Walk backwards. Stop if either we reach the target or the chain breaks.
  let cursor = currentVersion;
  let reachedTarget = false;
  while (cursor && cursor !== targetVersion) {
    const k = byFrom.get(cursor);
    if (!k) {
      // Chain broken — we don't have a kernel that reverts `cursor`. Save's
      // version is older than what we can fully reconstruct. Return what we
      // have so the user gets at-least-partial fidelity.
      missing.push(`${cursor}_to_?`);
      break;
    }
    _applyKernel(snapshot, k);
    walkedThrough.push(`${k.from}_to_${k.to}`);
    cursor = k.to;
  }
  reachedTarget = (cursor === targetVersion);
  return { snapshot, reachedTarget, walkedThrough, missing };
}

// ── Backward kernel application ─────────────────────────────────────────────

const CATEGORIES = ['cards', 'relics', 'enchantments'];

function _applyKernel(snapshot, kernel) {
  for (const cat of CATEGORIES) {
    const dict = kernel[cat];
    if (!dict || typeof dict !== 'object') continue;
    const arr = Array.isArray(snapshot[cat]) ? snapshot[cat] : (snapshot[cat] = []);

    for (const [name, fieldDiffs] of Object.entries(dict)) {
      _applyEntityDiffs(arr, name, fieldDiffs);
    }
  }
}

function _applyEntityDiffs(arr, name, fieldDiffs) {
  // Drop the per-entry `_source` raw text — it's a curation hint, not data.
  const fields = {};
  for (const [k, v] of Object.entries(fieldDiffs)) {
    if (k === '_source') continue;
    fields[k] = v;
  }
  if (Object.keys(fields).length === 0) return;

  const idx = arr.findIndex(x => x && x.name === name);

  // If every diff has `old: null`, the entity didn't exist at the target —
  // remove it from the snapshot if present.
  const allOldNull = Object.values(fields).every(d =>
    d && typeof d === 'object' && d.old === null);
  if (allOldNull) {
    if (idx !== -1) arr.splice(idx, 1);
    return;
  }

  // Otherwise: ensure the entry exists, then overwrite each listed field
  // with its `old` value. Fields the kernel doesn't mention stay as-is —
  // that's the whole point of partial diffs.
  let entry = idx === -1 ? null : arr[idx];
  if (!entry) {
    entry = { name };
    arr.push(entry);
  }
  for (const [field, diff] of Object.entries(fields)) {
    if (!diff || typeof diff !== 'object') continue;
    if ('old' in diff) entry[field] = diff.old;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _deepClone(o) {
  // structuredClone exists in Node 17+ and Electron's renderer; fall back to
  // JSON for older runtimes. Our data is plain JSON-compatible.
  if (typeof structuredClone === 'function') return structuredClone(o);
  return JSON.parse(JSON.stringify(o));
}

// ── Exports ─────────────────────────────────────────────────────────────────
// Use a uniquely-named identifier (instead of `_exports`) because the
// dashboard loads this file alongside scripts/render/renderer.js as classic
// <script>s — both share global scope, and `const _exports` in two of them
// triggers a SyntaxError on the second to parse.

const _kernelComposerExports = { composeSnapshot, _applyKernel, _applyEntityDiffs };
if (typeof module !== 'undefined' && module.exports) module.exports = _kernelComposerExports;
if (typeof window !== 'undefined') {
  window.kernelComposer = _kernelComposerExports;
}
