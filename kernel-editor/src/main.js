'use strict';
/**
 * kernel-editor/main.js — Electron main process.
 *
 * Single window. Reads kernel notes (auto-generated scaffolds) from
 *   <repo-root>/Release Version/data/kernel-notes/
 * Writes finalized kernels (cleaned up) to
 *   <repo-root>/Release Version/data/kernels/
 *
 * Same filename used in both folders so they're trivially paired.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs   = require('fs');
const path = require('path');

// kernel-editor lives at Release Version/kernel-editor/. All authoring
// artifacts (notes, finalized kernels, basis snapshot, manifest) sit
// alongside this file's parent. The dashboard fetches the published
// finalized kernels and manifest from GitHub at runtime — see the URL
// constants in Release Version/src/main.js.
const NOTES_DIR  = path.resolve(__dirname, '..', 'kernel-notes');
const KERNEL_DIR = path.resolve(__dirname, '..', 'kernels');
const MANIFEST   = path.resolve(__dirname, '..', 'manifest.json');
const BASIS_DIR  = path.resolve(__dirname, '..', 'basis');

// Where the current-patch simplified data lives. The renderer's lookup
// pane reads from here to show "what does the current schema look like for
// this card / relic / enchantment" so the user can word their kernel diffs
// against the live shape (incl. gold-wrapped keywords). Pre-integration the
// authoritative source is mock-test-app; post-integration it'll be the
// dashboard appdata. We try mock-test-app first, then fall back.
const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '.', '.config');
const SIMPLIFIED_CANDIDATES = [
  path.join(APPDATA, 'sts2-mock-test', 'Assets', 'data-simplified', 'eng'),
  path.join(APPDATA, 'sts2-dashboard', 'Assets', 'data-simplified', 'eng'),
  path.join(APPDATA, 'sts2-dashboard', 'Assets', 'data'),
];

let _simplifiedCache = null;
function loadSimplified() {
  if (_simplifiedCache) return _simplifiedCache;
  for (const dir of SIMPLIFIED_CANDIDATES) {
    if (!fs.existsSync(dir)) continue;
    const out = { _dir: dir, cards: [], relics: [], enchantments: [] };
    for (const cat of ['cards', 'relics', 'enchantments']) {
      const fp = path.join(dir, cat + '.json');
      if (!fs.existsSync(fp)) continue;
      try { out[cat] = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (_) { /* leave empty */ }
    }
    if (out.cards.length || out.relics.length || out.enchantments.length) {
      _simplifiedCache = out;
      return out;
    }
  }
  _simplifiedCache = { _dir: null, cards: [], relics: [], enchantments: [] };
  return _simplifiedCache;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 950,
    minWidth: 1100, minHeight: 700,
    backgroundColor: '#15151f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC ─────────────────────────────────────────────────────────────────────

// List notes available, plus whether each has a finalized counterpart yet.
ipcMain.handle('list-notes', () => {
  if (!fs.existsSync(NOTES_DIR)) return [];
  fs.mkdirSync(KERNEL_DIR, { recursive: true });
  return fs.readdirSync(NOTES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      // "0. ..." / "10. ..." → sort by leading numeric index, not alphabetically
      const na = parseInt(a.match(/^(\d+)\./)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/^(\d+)\./)?.[1] ?? '0', 10);
      return na - nb;
    })
    .map(f => ({
      file: f,
      finalized: fs.existsSync(path.join(KERNEL_DIR, f)),
    }));
});

// Read a single note + (if present) its finalized counterpart, so the editor
// can resume where the user left off.
ipcMain.handle('read-note', (_e, file) => {
  const safe = path.basename(String(file || ''));
  const np = path.join(NOTES_DIR, safe);
  const kp = path.join(KERNEL_DIR, safe);
  const out = { file: safe, note: null, kernel: null, oldStateAtTo: null, basisInfo: null, appliedKernels: [], composeReason: null };
  if (fs.existsSync(np)) {
    try { out.note = JSON.parse(fs.readFileSync(np, 'utf8')); }
    catch (e) { out.note = { _error: e.message }; }
  }
  if (fs.existsSync(kp)) {
    try { out.kernel = JSON.parse(fs.readFileSync(kp, 'utf8')); }
    catch (e) { out.kernel = { _error: e.message }; }
  }
  // Forward-compose state at scaffold.to so the editor can pre-fill `old`
  // values for every entity mentioned in the patch note. Walks finalized
  // kernels chronologically from basis up to (and including) scaffold.to,
  // applying each kernel's `new` field values to evolve forward.
  const targetVersion = (out.note && out.note.to) || (out.kernel && out.kernel.to);
  if (targetVersion) {
    try {
      const composed = composeStateAt(targetVersion);
      if (composed) {
        out.oldStateAtTo   = composed.state;          // null if older-than-basis
        out.basisInfo      = composed.basisInfo;
        out.appliedKernels = composed.appliedKernels;
        out.composeReason  = composed.reason || null; // e.g. 'older-than-basis'
      }
    } catch (e) {
      console.warn('compose state failed:', e.message);
    }
  }
  return out;
});

// ── Basis snapshot + forward composition ─────────────────────────────────────
//
// The basis is a captured copy of the dashboard's simplified data at some
// version V_basis (recorded in basis-info.json). When the user authors a
// kernel for a NEW patch (anything > V_basis), the editor pre-fills `old`
// values by composing forward: start from basis, apply each finalized
// kernel's `new` values for every kernel where basis_version < kernel.from
// <= scaffold.to. This works ONLY for patches newer than the basis.

function loadBasis() {
  const out = { cards: [], relics: [], enchantments: [], info: null };
  for (const cat of ['cards', 'relics', 'enchantments']) {
    const fp = path.join(BASIS_DIR, `${cat}.json`);
    if (fs.existsSync(fp)) {
      try { out[cat] = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) {}
    }
  }
  const infoFp = path.join(BASIS_DIR, 'basis-info.json');
  if (fs.existsSync(infoFp)) {
    try { out.info = JSON.parse(fs.readFileSync(infoFp, 'utf8')); } catch (_) {}
  }
  return out;
}

function loadAllFinalizedKernels() {
  if (!fs.existsSync(KERNEL_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(KERNEL_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const k = JSON.parse(fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'));
      if (k && k.from && k.to) out.push(k);
    } catch (_) {}
  }
  return out;
}

// Apply a single kernel's `new` values to a state object, evolving FORWARD
// (older → newer). Mirrors the dashboard's backward composer in reverse:
// instead of taking `old` to revert, we take `new` to advance.
function applyForward(state, kernel) {
  for (const cat of ['cards', 'relics', 'enchantments']) {
    const dict = kernel[cat];
    if (!dict || typeof dict !== 'object') continue;
    if (!Array.isArray(state[cat])) state[cat] = [];
    for (const [name, fields] of Object.entries(dict)) {
      const fieldEntries = Object.entries(fields).filter(([k]) => k !== '_source');
      if (fieldEntries.length === 0) continue;
      // If every `new` is null, the entity didn't exist at the newer
      // version — remove it from state.
      const allNewNull = fieldEntries.every(([, v]) => v && typeof v === 'object' && v.new === null);
      const idx = state[cat].findIndex(x => x && x.name === name);
      if (allNewNull) {
        if (idx !== -1) state[cat].splice(idx, 1);
        continue;
      }
      let entry = idx === -1 ? null : state[cat][idx];
      if (!entry) { entry = { name }; state[cat].push(entry); }
      for (const [field, v] of fieldEntries) {
        if (v && typeof v === 'object' && 'new' in v) entry[field] = v.new;
      }
    }
  }
}

function composeStateAt(targetVersion) {
  const basis = loadBasis();
  if (!basis.info || !basis.info.version) return null;     // no basis snapshot
  if (!fs.existsSync(MANIFEST)) return null;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.versions)) return null;

  // Build a chronological version → index map from the manifest, then tack
  // current_version on the end if it isn't already there.
  const verIdx = new Map();
  manifest.versions.forEach((v, i) => verIdx.set(v.version, i));
  if (manifest.current_version && !verIdx.has(manifest.current_version)) {
    verIdx.set(manifest.current_version, manifest.versions.length);
  }
  const basisIdx  = verIdx.get(basis.info.version);
  const targetIdx = verIdx.get(targetVersion);
  if (basisIdx == null || targetIdx == null) return null;

  // Refuse to pre-fill when the scaffold's `to` is OLDER than the basis.
  // The basis is a frozen snapshot of "newest data at snapshot time"; we
  // only know how to evolve it forward via kernel `new` values. Going
  // backwards would require reverse composition AGAINST the basis, which
  // defeats the point of having a basis. Returning null here means the
  // editor falls back to no pre-fill (status line tells the user why),
  // and they can author the older kernel from scratch / from the live
  // simplified-data lookup pane as before.
  if (targetIdx < basisIdx) {
    return { state: null, basisInfo: basis.info, appliedKernels: [], reason: 'older-than-basis' };
  }

  // Deep-clone the basis so we don't mutate the on-disk snapshot.
  const state = {
    cards:        JSON.parse(JSON.stringify(basis.cards)),
    relics:       JSON.parse(JSON.stringify(basis.relics)),
    enchantments: JSON.parse(JSON.stringify(basis.enchantments)),
  };

  // Walk finalized kernels whose `from` lies in (basis_version, target].
  // Sort by `from` chronologically so we apply oldest → newest.
  const kernels = loadAllFinalizedKernels()
    .filter(k => {
      const fi = verIdx.get(k.from);
      return fi != null && fi > basisIdx && fi <= targetIdx;
    })
    .sort((a, b) => verIdx.get(a.from) - verIdx.get(b.from));

  for (const k of kernels) applyForward(state, k);

  return { state, basisInfo: basis.info, appliedKernels: kernels.map(k => `${k.from}_to_${k.to}`) };
}

// Save the finalized kernel. Caller is expected to have done the cleanup
// (drop empty entries / empty field rows); this handler just writes JSON.
ipcMain.handle('save-kernel', (_e, file, kernel) => {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.json')) throw new Error('refusing non-.json filename');
  fs.mkdirSync(KERNEL_DIR, { recursive: true });
  const dest = path.join(KERNEL_DIR, safe);
  fs.writeFileSync(dest, JSON.stringify(kernel, null, 2), 'utf8');
  return { ok: true, path: dest };
});

ipcMain.handle('paths', () => ({
  NOTES_DIR,
  KERNEL_DIR,
  SIMPLIFIED_DIR: loadSimplified()._dir,
}));

// ── LLM-assisted "new" value suggestion ─────────────────────────────────────
//
// Reads the Gemini API key from llm-config.json (gitignored). On click of an
// entry's "Suggest new" button, the renderer sends the entity name + the
// patch-note _source text + the current `old` values + the schema field list.
// We build a prompt, call Gemini, parse the JSON response, and return a
// dict of { fieldName: newValue } for the renderer to drop into the `new`
// textboxes. Saving / finalizing is still a manual step — this just
// pre-populates suggestions.

const LLM_CONFIG_PATH = path.resolve(__dirname, '..', 'llm-config.json');

function loadLlmConfig() {
  if (!fs.existsSync(LLM_CONFIG_PATH)) {
    throw new Error('llm-config.json not found — create it with { "apiKey": "...", "model": "gemini-1.5-flash-latest" }');
  }
  const cfg = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf8'));
  if (!cfg.apiKey || cfg.apiKey === 'PASTE_YOUR_ROTATED_GEMINI_API_KEY_HERE') {
    throw new Error('Gemini API key not set in llm-config.json');
  }
  return cfg;
}

function buildLlmPrompt({ entityName, category, sourceText, oldValues, schema }) {
  const oldLines = Object.entries(oldValues)
    .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join('\n') || '  (none)';
  return `You are helping author a backward-delta kernel for the game Slay the Spire 2.

Entity: ${entityName}  (category: ${category})

Patch-note source text (raw bullet from the wiki, may be terse / messy):
${sourceText || '(no source text — infer from old values + schema)'}

Current "old" values (state of the entity BEFORE this patch — values that the kernel reverts to):
${oldLines}

Schema fields available for ${category}:
${schema.join(', ')}

Task: figure out the "new" values (state AFTER this patch). Return ONLY the schema fields that the patch text says actually changed; omit fields that didn't change. Use the exact same value formatting / markup as the old values (preserve [gold]…[/gold], [blue]…[/blue], [energy:N], \\n line breaks, etc.). Numbers stay numbers, booleans stay booleans, strings stay strings.

Respond with JSON of the form:
{ "fieldName1": <new value>, "fieldName2": <new value>, ... }

Do NOT wrap in markdown fences. Do NOT include explanations. JSON only.`;
}

async function callGemini(prompt, cfg) {
  const model = cfg.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty content');
  try { return JSON.parse(text); }
  catch (_) {
    // Sometimes models slip in fenced markdown despite responseMimeType.
    const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(stripped);
  }
}

ipcMain.handle('llm-suggest-new', async (_e, opts) => {
  try {
    const cfg = loadLlmConfig();
    const prompt = buildLlmPrompt(opts);
    const result = await callGemini(prompt, cfg);
    return { ok: true, suggestions: result, prompt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Search across cards/relics/enchantments by substring match (case-insensitive).
// Returns up to `limit` matches per category, with the matched simplified-schema
// entry attached so the lookup panel can show its current shape.
ipcMain.handle('lookup', (_e, query, limit = 8) => {
  const data = loadSimplified();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { cards: [], relics: [], enchantments: [], dir: data._dir };
  const search = (arr) => arr
    .filter(e => e && typeof e.name === 'string' && e.name.toLowerCase().includes(q))
    .slice(0, limit);
  return {
    dir:          data._dir,
    cards:        search(data.cards),
    relics:       search(data.relics),
    enchantments: search(data.enchantments),
  };
});

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
