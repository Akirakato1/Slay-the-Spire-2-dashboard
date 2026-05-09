'use strict';
/**
 * kernel-editor/renderer.js — UI logic for the kernel-builder app.
 *
 * State lives entirely in the DOM. On Save we walk the DOM, drop empty
 * entries / empty field rows, collapse `{old, new}` pairs into the schema,
 * and round-trip through window.api.saveKernel.
 */

const $ = (id) => document.getElementById(id);

// Field choices per category — pulled straight from the simplified-data
// schemas. Free-form `name` always available; everything else picks from
// these. (Image fields are intentionally absent — kernels never track them.)
const FIELDS = {
  cards: [
    'name', 'character', 'rarity', 'type',
    'canUpgrade', 'multiplayer',
    'description', 'descriptionUpgraded',
    'manaCost', 'manaCostUpgraded',
    'starCost', 'starCostUpgraded',
  ],
  relics: [
    'name', 'rarity', 'character', 'description',
  ],
  enchantments: [
    'name', 'description', 'applicableTo', 'isStackable',
  ],
};

const CATEGORIES = ['cards', 'relics', 'enchantments'];

let _currentFile = null;
let _currentNote = null;   // raw note JSON (for the right-pane source display)

// ── File picker / loading ───────────────────────────────────────────────────

async function refreshFileList() {
  const picker = $('file-picker');
  picker.innerHTML = '';
  const items = await window.api.listNotes();
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.file;
    opt.textContent = (it.finalized ? '✓ ' : '  ') + it.file;
    picker.appendChild(opt);
  }
  if (items.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no kernel notes found)';
    picker.appendChild(opt);
    picker.disabled = true;
  } else {
    picker.disabled = false;
  }
}

async function loadFile(file) {
  if (!file) return;
  _currentFile = file;
  const data = await window.api.readNote(file);
  _currentNote = data.note;

  // Header fields — read-only from note, summary editable.
  const src = data.kernel || data.note || {};
  $('hdr-from').value    = src.from        || '';
  $('hdr-to').value      = src.to          || '';
  $('hdr-date').value    = src.released_on || '';
  $('hdr-summary').value = src.summary     || '';
  $('meta').textContent = `${src.from || '?'} → ${src.to || '?'} · ${src.released_on || ''}`;

  // Index the forward-composed state by entity name for fast lookup as we
  // populate entries. The composer returns full cards/relics/enchantments
  // arrays representing the state at scaffold.to — used to pre-fill `old`
  // values on every field row so the user only has to type the `new` side.
  const oldStateIdx = _indexComposedState(data.oldStateAtTo);

  // Builder body. Two distinct modes:
  //   - finalized exists → render exactly what was saved, no basis pre-fill,
  //     no extra schema-field rows. The user has already curated this; we
  //     don't want to overwrite their work or clutter with empty rows.
  //   - no finalized yet → seed from the patch-note scaffold; add a row for
  //     every schema field with `old` pre-filled from the forward-composed
  //     basis state.
  const isFinalized = !!data.kernel;
  for (const cat of CATEGORIES) {
    const container = $('entries-' + cat);
    container.innerHTML = '';
    const finalized = data.kernel && data.kernel[cat];
    const note      = data.note   && data.note[cat];
    const seed      = finalized || note || {};
    for (const [name, fields] of Object.entries(seed)) {
      const oldDefaults = oldStateIdx[cat] && oldStateIdx[cat].get(name);
      addEntry(cat, name, fields, oldDefaults, isFinalized);
    }
  }

  renderNotesPane(data.note);
  // Status line reflects the rendering mode.
  if (isFinalized) {
    // Saved kernel: render exactly as stored, no pre-fill, no extra rows.
    setStatus('loaded (resuming finalized — saved values rendered as-is, basis pre-fill skipped)');
  } else if (data.composeReason === 'older-than-basis') {
    // Scaffold's `to` is older than basis. Pre-fill skipped; no overwrite.
    setStatus(`loaded (fresh from notes; pre-fill disabled — scaffold's "to" v${data.note?.to || '?'} is OLDER than basis v${data.basisInfo?.version || '?'})`);
  } else if (data.basisInfo && oldStateIdx._any) {
    const applied = (data.appliedKernels || []).length;
    const composeNote = applied === 0
      ? `state at ${data.basisInfo.version} (basis)`
      : `state at ${data.note?.to || '?'} (basis ${data.basisInfo.version} + ${applied} intermediate kernel${applied === 1 ? '' : 's'} forward-composed)`;
    setStatus(`loaded (fresh from notes; old-values = ${composeNote})`);
  } else if (data.note && Object.keys(data.note.cards || {}).length + Object.keys(data.note.relics || {}).length + Object.keys(data.note.enchantments || {}).length > 0) {
    setStatus('loaded (fresh from notes, no basis snapshot — run `npm run snapshot` to enable old-value pre-fill)');
  } else {
    setStatus('loaded (fresh)');
  }
}

// Build { cards: Map, relics: Map, enchantments: Map } where each Map is
// name → entity-row from the forward-composed state. `_any` flags whether
// any non-empty category was returned.
function _indexComposedState(state) {
  const out = { cards: null, relics: null, enchantments: null, _any: false };
  if (!state) return out;
  for (const cat of CATEGORIES) {
    const arr = state[cat];
    if (!Array.isArray(arr)) continue;
    const m = new Map();
    for (const e of arr) if (e && e.name) m.set(e.name, e);
    out[cat] = m;
    if (m.size) out._any = true;
  }
  return out;
}

// ── Notes pane (right) ──────────────────────────────────────────────────────

function renderNotesPane(note) {
  const root = $('notes-list');
  root.innerHTML = '';
  if (!note) { root.innerHTML = '<div class="empty">No note loaded.</div>'; return; }

  let any = false;
  for (const cat of CATEGORIES) {
    const dict = note[cat] || {};
    const names = Object.keys(dict);
    if (names.length === 0) continue;
    any = true;
    const sec = document.createElement('div');
    sec.className = 'note-cat';
    sec.innerHTML = `<div class="note-cat-head">${cat.toUpperCase()} (${names.length})</div>`;
    for (const n of names) {
      const e = dict[n];
      const div = document.createElement('div');
      div.className = 'note-entry';
      // Click anywhere on the entry to copy its name to the clipboard —
      // saves a lot of alt-tabbing during kernel authoring.
      div.dataset.name = n;
      div.title = `Click to copy "${n}"`;
      div.addEventListener('click', () => copyNameFromEntry(div));
      const fieldsList = Object.keys(e).filter(k => k !== '_source');
      const presetHint = fieldsList.length
        ? `<div class="src" style="color:#7a9a7a;">auto-filled: ${fieldsList.join(', ')}</div>`
        : '';
      div.innerHTML = `
        <div class="nm">${n}</div>
        ${presetHint}
        <div class="src">${(e._source || '').replace(/</g, '&lt;')}</div>
      `;
      sec.appendChild(div);
    }
    root.appendChild(sec);
  }
  if (!any) root.innerHTML = '<div class="empty">This note has no card/relic/enchantment changes.</div>';
}

async function copyNameFromEntry(div) {
  const name = div.dataset.name || '';
  if (!name) return;
  try {
    await navigator.clipboard.writeText(name);
    flashCopied(div);
    setStatus(`copied "${name}"`);
  } catch (e) {
    setStatus('clipboard failed: ' + e.message);
  }
}

function flashCopied(div) {
  div.classList.add('copied');
  setTimeout(() => div.classList.remove('copied'), 450);
}

// ── Builder DOM construction ────────────────────────────────────────────────

function addEntry(cat, initialName = '', initialFields = {}, oldDefaults = null, isFinalized = false) {
  const container = $('entries-' + cat);
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.dataset.cat = cat;

  // Head: name input + LLM suggest button + delete entry button.
  const head = document.createElement('div');
  head.className = 'entry-head';
  const nameInput = document.createElement('input');
  nameInput.className = 'name';
  nameInput.placeholder = 'Entity name (e.g. Strike)';
  nameInput.value = initialName;
  head.appendChild(nameInput);

  // Gemini-backed "Suggest new" button. Sends the patch-note source +
  // current `old` values to the LLM and asks it to predict the `new`
  // values. Suggestions land in the corresponding new-side textboxes;
  // user reviews and saves manually.
  const llmBtn = document.createElement('button');
  llmBtn.className = 'llm-suggest-btn';
  llmBtn.type = 'button';
  llmBtn.textContent = '🤖';
  llmBtn.title = 'Suggest "new" values via Gemini';
  llmBtn.addEventListener('click', () => suggestNewValuesForEntry(entry, cat));
  head.appendChild(llmBtn);

  const del = document.createElement('button');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Remove this entry';
  del.addEventListener('click', () => entry.remove());
  head.appendChild(del);
  entry.appendChild(head);

  // Field rows.
  const fields = document.createElement('div');
  fields.className = 'fields';
  entry.appendChild(fields);

  // Bottom row: "+ Add field" + "Clean empty rows" — both operate on this
  // entry's field container.
  const entryActions = document.createElement('div');
  entryActions.className = 'entry-actions';

  const addFieldBtn = document.createElement('button');
  addFieldBtn.className = 'add-field-btn';
  addFieldBtn.textContent = '+ Add field';
  addFieldBtn.addEventListener('click', () => addFieldRow(fields, cat));
  entryActions.appendChild(addFieldBtn);

  // Cleanup helper: delete every field row whose old AND new inputs are
  // blank. Saves the user from picking through 10 untouched scaffold rows
  // when they only filled in 2.
  const cleanBtn = document.createElement('button');
  cleanBtn.className = 'clean-empty-btn';
  cleanBtn.textContent = 'Clean empty rows';
  cleanBtn.title = 'Remove field rows where both old and new are blank';
  cleanBtn.addEventListener('click', () => {
    let removed = 0;
    for (const row of [...fields.querySelectorAll('.field-row')]) {
      if (!row._old.value.trim() && !row._new.value.trim()) {
        row.remove();
        removed++;
      }
    }
    setStatus(removed === 0 ? 'no empty rows' : `removed ${removed} empty row${removed === 1 ? '' : 's'}`);
  });
  entryActions.appendChild(cleanBtn);

  entry.appendChild(entryActions);

  // Pick a default `old` value from the forward-composed basis snapshot,
  // ONLY for fresh-from-scaffold loads. Saved (finalized) kernels are
  // rendered as-is — we never overwrite the user's curated work.
  const oldFromBasis = (fieldName) => {
    if (isFinalized) return '';
    if (!oldDefaults) return '';
    const v = oldDefaults[fieldName];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  };

  // Pre-populate from initialFields. For finalized kernels, use the saved
  // values verbatim. For fresh scaffolds, fall back to basis-composed
  // values when the scaffold's `old` is empty (the parser doesn't always
  // know the old value).
  const seenFields = new Set();
  for (const [k, v] of Object.entries(initialFields)) {
    if (k === '_source') continue;
    seenFields.add(k);
    if (v && typeof v === 'object' && ('old' in v || 'new' in v)) {
      const oldVal = isFinalized
        ? (v.old ?? '')                                              // saved: use exactly what's stored
        : ((v.old !== '' && v.old != null) ? v.old : oldFromBasis(k));
      addFieldRow(fields, cat, k, oldVal, v.new);
    } else {
      addFieldRow(fields, cat, k, v, null);
    }
  }

  // For fresh scaffolds (and entirely new entries from "+ Add card"): add
  // a row for every schema field that hasn't been added yet. For finalized
  // kernels: SKIP this — only show rows the user actually saved. They can
  // still hit "+ Add field" to add more.
  if (!isFinalized) {
    for (const f of FIELDS[cat]) {
      if (seenFields.has(f)) continue;
      addFieldRow(fields, cat, f, oldFromBasis(f), '');
    }
  }
  if (Object.keys(initialFields).length === 0) nameInput.focus();

  container.appendChild(entry);
}

function addFieldRow(fieldsContainer, cat, fieldName = '', oldVal = '', newVal = '') {
  const row = document.createElement('div');
  row.className = 'field-row';

  // Field selector — dropdown of known fields plus a "(custom)" option.
  const sel = document.createElement('select');
  for (const f of FIELDS[cat]) {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__'; custom.textContent = '(custom…)';
  sel.appendChild(custom);

  // If the saved field name matches a known one, select it; otherwise mark as custom.
  if (fieldName && FIELDS[cat].includes(fieldName)) {
    sel.value = fieldName;
  } else if (fieldName) {
    sel.value = '__custom__';
  }
  row.appendChild(sel);

  // If custom, show a free-form name input next to the selector.
  const customInput = document.createElement('input');
  customInput.placeholder = 'custom field name';
  customInput.value = (sel.value === '__custom__') ? fieldName : '';
  customInput.style.display = (sel.value === '__custom__') ? '' : 'none';
  row.insertBefore(customInput, row.children[0].nextSibling);

  sel.addEventListener('change', () => {
    if (sel.value === '__custom__') {
      customInput.style.display = '';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
    }
  });

  // Old / new value inputs.
  const oldI = document.createElement('input');
  oldI.placeholder = 'old';
  oldI.value = formatVal(oldVal);
  const newI = document.createElement('input');
  newI.placeholder = 'new';
  newI.value = formatVal(newVal);
  row.appendChild(oldI);
  row.appendChild(newI);

  // Delete button.
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'Remove this field';
  x.addEventListener('click', () => row.remove());
  row.appendChild(x);

  // Tag elements so we can read them back later.
  row.dataset.role = 'field-row';
  row._sel = sel;
  row._custom = customInput;
  row._old = oldI;
  row._new = newI;

  fieldsContainer.appendChild(row);
}

function formatVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// Parse user input into a typed value. Empty input → null. Numeric strings →
// number. "true"/"false" → boolean. Everything else stays a string.
function parseVal(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  if (s === 'null') return null;
  if (s === 'true')  return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ── LLM suggestion ──────────────────────────────────────────────────────────
//
// Called from the per-entry 🤖 button. Gathers the entity's name, its
// patch-note _source text (from the loaded scaffold), and current `old`
// values from each row, then asks Gemini to predict the `new` values.
// Suggestions are dropped into the corresponding `new` textboxes — user
// reviews, edits, and saves/finalizes manually.

async function suggestNewValuesForEntry(entry, cat) {
  const name = entry.querySelector('input.name').value.trim();
  if (!name) { setStatus('entity name required before suggesting'); return; }

  // Pull source text from the loaded scaffold (if any) — most informative
  // input the LLM has.
  const sourceText = (_currentNote && _currentNote[cat] && _currentNote[cat][name] && _currentNote[cat][name]._source) || '';

  // Read current `old` values per row (only rows where old is non-blank).
  const rows  = [...entry.querySelectorAll('.field-row')];
  const oldValues = {};
  const rowByField = {};
  for (const row of rows) {
    const key = row._sel.value === '__custom__' ? row._custom.value.trim() : row._sel.value;
    if (!key) continue;
    rowByField[key] = row;
    const raw = row._old.value.trim();
    if (raw) oldValues[key] = parseVal(row._old.value);
  }

  const llmBtn = entry.querySelector('.llm-suggest-btn');
  const prevLabel = llmBtn.textContent;
  llmBtn.textContent = '⏳';
  llmBtn.disabled = true;
  setStatus(`asking Gemini about "${name}"…`);

  try {
    const result = await window.api.llmSuggestNew({
      entityName: name,
      category:   cat,
      sourceText,
      oldValues,
      schema:     FIELDS[cat],
    });
    if (!result || !result.ok) {
      throw new Error(result?.error || 'unknown error');
    }
    const suggestions = result.suggestions || {};
    let filled = 0;
    for (const [field, value] of Object.entries(suggestions)) {
      let row = rowByField[field];
      if (!row) {
        // Field isn't in the entry yet — add a row for it. Use empty old
        // so the user explicitly confirms what the old value should be.
        addFieldRow(entry.querySelector('.fields'), cat, field, '', '');
        const all = [...entry.querySelectorAll('.field-row')];
        row = all[all.length - 1];
      }
      row._new.value = typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value));
      filled++;
    }
    setStatus(`Gemini filled ${filled} new value${filled === 1 ? '' : 's'} for "${name}" — review before saving`);
  } catch (e) {
    setStatus(`Gemini error: ${e.message}`);
  } finally {
    llmBtn.textContent = prevLabel;
    llmBtn.disabled = false;
  }
}

// ── Save (with cleanup) ─────────────────────────────────────────────────────

// Build the kernel object from current DOM state.
//   strict=false (Save):     keep any row where AT LEAST ONE of old/new has
//                            content. Half-filled rows are saved verbatim
//                            with the missing side as JSON null. Use this
//                            for incremental progress saves while the user
//                            is still researching `new` values.
//   strict=true  (Finalize): keep ONLY rows where BOTH old and new have
//                            content. Drops every half-filled row. Use this
//                            for the publish-to-repo pass.
function buildKernelFromDOM({ strict = false } = {}) {
  const out = {
    from:        $('hdr-from').value || null,
    to:          $('hdr-to').value || null,
    released_on: $('hdr-date').value || null,
    summary:     $('hdr-summary').value || '',
  };
  for (const cat of CATEGORIES) {
    const cont = $('entries-' + cat);
    const dict = {};
    for (const entry of cont.querySelectorAll('.entry')) {
      const name = entry.querySelector('input.name').value.trim();
      if (!name) continue;
      const fields = {};
      for (const row of entry.querySelectorAll('.field-row')) {
        const key = row._sel.value === '__custom__'
          ? row._custom.value.trim()
          : row._sel.value;
        if (!key) continue;
        const oldRaw = row._old.value.trim();
        const newRaw = row._new.value.trim();
        if (strict) {
          if (!oldRaw || !newRaw) continue;          // strict: BOTH must be filled
        } else {
          if (!oldRaw && !newRaw) continue;          // lax: drop only when both blank
        }
        fields[key] = { old: parseVal(row._old.value), new: parseVal(row._new.value) };
      }
      // Drop the entry entirely if it has no fields after cleanup.
      if (Object.keys(fields).length === 0) continue;
      dict[name] = fields;
    }
    out[cat] = dict;
  }
  return out;
}

async function saveCurrent() {
  if (!_currentFile) { setStatus('no file loaded'); return; }
  const kernel = buildKernelFromDOM({ strict: false });
  setStatus('saving…');
  try {
    const r = await window.api.saveKernel(_currentFile, kernel);
    setStatus(`saved → ${r.path.split(/[\\/]/).pop()}`);
    refreshFileList();  // refresh the ✓ marker in the picker
  } catch (e) {
    setStatus('save failed: ' + e.message);
  }
}

async function finalizeCurrent() {
  if (!_currentFile) { setStatus('no file loaded'); return; }
  const kernel = buildKernelFromDOM({ strict: true });
  // Quick stats so the user sees what got dropped.
  const counts = CATEGORIES.reduce((acc, cat) => {
    acc[cat] = Object.keys(kernel[cat] || {}).length;
    return acc;
  }, {});
  setStatus('finalizing…');
  try {
    const r = await window.api.saveKernel(_currentFile, kernel);
    setStatus(`finalized → ${r.path.split(/[\\/]/).pop()} · cards:${counts.cards} relics:${counts.relics} ench:${counts.enchantments}`);
    refreshFileList();
    // Reload so the editor displays the cleaned-up state (and re-renders
    // in finalized mode — only the surviving rows show, no schema padding).
    if (_currentFile) loadFile(_currentFile);
  } catch (e) {
    setStatus('finalize failed: ' + e.message);
  }
}

function setStatus(t) { $('status').textContent = t; }

// ── Markup toolbar ──────────────────────────────────────────────────────────
//
// Each button operates on whichever <input> is currently focused. mousedown
// is preventDefault'd at registration time so clicking the button doesn't
// blur the input — focus and selection survive across the click. Read-only
// inputs (the from/to/date headers) are skipped so a stray click can't mangle
// them.

function targetInput() {
  const el = document.activeElement;
  if (!el) return null;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return null;
  if (el.readOnly) return null;
  return el;
}

// Wrap the current selection with `[<tag>]` … `[/<tag>]`. If nothing is
// selected, insert empty tags and put the caret between them.
function applyWrap(input, tag) {
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  const before = input.value.slice(0, start);
  const sel    = input.value.slice(start, end);
  const after  = input.value.slice(end);
  const open   = `[${tag}]`;
  const close  = `[/${tag}]`;
  input.value = before + open + sel + close + after;
  if (sel === '') {
    const pos = start + open.length;
    input.setSelectionRange(pos, pos);
  } else {
    input.setSelectionRange(start + open.length, start + open.length + sel.length);
  }
  input.focus();
}

// Replace the selection with `[<kind>:N]`. N comes from the selected text if
// it's a positive integer; otherwise defaults to 1 and the caret is parked
// on the digit so the user can type a different count.
function applyIcon(input, kind) {
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  const before = input.value.slice(0, start);
  const sel    = input.value.slice(start, end);
  const after  = input.value.slice(end);
  const n   = /^\d+$/.test(sel.trim()) ? sel.trim() : '1';
  const tag = `[${kind}:${n}]`;
  input.value = before + tag + after;
  if (/^\d+$/.test(sel.trim())) {
    // Selection was a number → drop caret right after the inserted tag.
    const pos = start + tag.length;
    input.setSelectionRange(pos, pos);
  } else {
    // Caret-only or non-digit selection → highlight the "1" so a single
    // keystroke replaces it with whatever count the user actually wants.
    const digitStart = start + `[${kind}:`.length;
    input.setSelectionRange(digitStart, digitStart + n.length);
  }
  input.focus();
}

function wireMarkupToolbar() {
  for (const btn of document.querySelectorAll('#markup-toolbar button')) {
    // Stop the focus from leaving the active input on click.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const el = targetInput();
      if (!el) { setStatus('focus a description input first'); return; }
      if (btn.dataset.wrap) applyWrap(el, btn.dataset.wrap);
      else if (btn.dataset.icon) applyIcon(el, btn.dataset.icon);
    });
  }
}

// ── Lookup pane ─────────────────────────────────────────────────────────────

const HIDDEN_FIELDS = new Set(['imageFile']);  // never useful for kernel authoring

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderLookupValue(v) {
  if (v === null || v === undefined) return '<span class="n">null</span>';
  // JSON.stringify gives a JSON-style quoted string with `\n` written as
  // literal `\n` (and quotes escaped). That's what the user wants to be
  // able to copy verbatim into a kernel old/new field.
  if (typeof v === 'string')   return `<span class="s">${escHtml(JSON.stringify(v))}</span>`;
  if (typeof v === 'number')   return `<span class="n">${v}</span>`;
  if (typeof v === 'boolean')  return `<span class="b">${v}</span>`;
  return escHtml(JSON.stringify(v));
}

function renderLookupEntry(entry) {
  const lines = [];
  for (const [k, v] of Object.entries(entry)) {
    if (HIDDEN_FIELDS.has(k)) continue;
    lines.push(`<span class="k">${escHtml(k)}</span>: ${renderLookupValue(v)}`);
  }
  return `
    <div class="lookup-entry">
      <div class="lookup-name">${escHtml(entry.name || '?')}</div>
      <div class="lookup-fields">${lines.join('\n')}</div>
    </div>
  `;
}

function renderLookupResults(res) {
  const root = $('lookup-results');
  const total = res.cards.length + res.relics.length + res.enchantments.length;
  if (total === 0) {
    root.innerHTML = '<div class="empty">No matches.</div>';
    return;
  }
  const parts = [];
  for (const cat of ['cards', 'relics', 'enchantments']) {
    if (res[cat].length === 0) continue;
    parts.push(`<div class="lookup-cat">
      <div class="lookup-cat-head">${cat} (${res[cat].length})</div>
      ${res[cat].map(renderLookupEntry).join('')}
    </div>`);
  }
  root.innerHTML = parts.join('');
}

let _lookupTimer = null;
async function runLookup() {
  const q = $('lookup-input').value.trim();
  if (!q) {
    $('lookup-results').innerHTML = '<div class="empty">Type a name to search.</div>';
    return;
  }
  const res = await window.api.lookup(q, 8);
  renderLookupResults(res);
}

// ── Wire up ─────────────────────────────────────────────────────────────────

async function init() {
  for (const btn of document.querySelectorAll('button[data-add]')) {
    btn.addEventListener('click', () => addEntry(btn.dataset.add));
  }
  $('save-btn').addEventListener('click', saveCurrent);
  $('finalize-btn').addEventListener('click', finalizeCurrent);
  $('file-picker').addEventListener('change', (e) => loadFile(e.target.value));

  wireMarkupToolbar();

  // Lookup input: debounced live search.
  $('lookup-input').addEventListener('input', () => {
    if (_lookupTimer) clearTimeout(_lookupTimer);
    _lookupTimer = setTimeout(runLookup, 120);
  });

  // Show which simplified-data dir we ended up reading.
  const paths = await window.api.paths();
  $('lookup-source').textContent = paths.SIMPLIFIED_DIR
    ? `from ${paths.SIMPLIFIED_DIR.split(/[\\/]/).slice(-3).join('/')}`
    : 'no simplified data found — run the simplifier first';

  await refreshFileList();
  const picker = $('file-picker');
  if (picker.value) loadFile(picker.value);

  $('lookup-results').innerHTML = '<div class="empty">Type a name to search.</div>';
}

init();
