'use strict';
/**
 * parse_patch_notes.js — Pull patch notes from the STS2 wiki and emit one
 * "kernel" JSON file per version transition, plus a manifest.
 *
 * Usage:  node scripts/parse_patch_notes.js
 *
 * Output:
 *   <repo>/Release Version/data/manifest.json
 *   <repo>/kernel-editor/kernel-notes/<index>. v<from>_to_v<to>.json
 *     (one per consecutive-version pair)
 *
 * Kernel format = BACKWARD delta. Each kernel reverts data FROM `from`
 * (newer) TO `to` (older). For every entity (card / relic / enchantment)
 * whose simplified-schema fields changed, the kernel lists *only the
 * changed keys* with `{ old, new }` value pairs. The renderer reconstructs
 * a save's view by starting from current data and walking kernels backwards,
 * setting each listed field to its `old` value until reaching the save's
 * build_id.
 *
 *   `events` / `potions` are intentionally not tracked (don't affect render).
 *   `imageFile` is intentionally not tracked (always use current image).
 *
 * Auto-extraction is conservative: this pass only auto-fills fields where the
 * heuristic is unambiguous (rarity, mana cost, name change). Everything else
 * is left blank under `_source` with the raw wiki bullet for hand-curation.
 */

const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const SCRIPT_DIR = __dirname;
// Auto-generated scaffolds live inside kernel-editor/kernel-notes/ — the
// editor reads them, lets the user fill in old/new values, and writes the
// finalized result into kernel-editor/kernels/ (sibling, NOT this dir).
const KERNEL_DIR  = path.resolve(SCRIPT_DIR, '..', 'kernel-notes');
// Manifest sits at the kernel-editor root. The dashboard fetches it from
// GitHub at runtime alongside the finalized kernels; no bundled copy.
const MANIFEST    = path.resolve(SCRIPT_DIR, '..', 'manifest.json');

// Where the live wiki data sits (used to categorize entities by name → cat).
// Mirrors the appdata path the dashboard reads from at runtime.
const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '.', '.config');
const LIVE_DATA_DIR = path.join(APPDATA, 'sts2-dashboard', 'Assets', 'data');

const WIKI_BASE = 'https://slaythespire.wiki.gg';
const PATCH_PAGE = 'Slay_the_Spire_2:Patch_Notes';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0';

// Sections that affect renderable card / relic / event / potion / enchantment
// data. Everything else (ART, UI, WRITING, BUG FIXES, LOC, MODDING) is skipped.
const RELEVANT_SECTIONS = new Set([
  'CONTENT', 'BALANCE', 'CONTENT AND BALANCE', 'CONTENT & BALANCE',
]);

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchPageHtml(pageName) {
  const encoded = encodeURIComponent(pageName).replace(/%3A/g, ':');
  const url = `${WIKI_BASE}/api.php?action=parse&page=${encoded}&prop=text&format=json&disableeditsection=true&disabletoc=true`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Wiki API error: ${data.error.info || JSON.stringify(data.error)}`);
  return data.parse.text['*'];
}

// ── Lightweight HTML helpers ──────────────────────────────────────────────────

function decode(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(s) {
  if (!s) return '';
  return decode(
    s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  ).replace(/\s+/g, ' ').trim();
}

// Extract the first <b>...</b> text from an HTML fragment (used to grab the
// entity name being changed — patch notes consistently bold the card / relic).
function firstBold(html) {
  const m = html.match(/<b\b[^>]*>([\s\S]*?)<\/b>/i);
  return m ? stripTags(m[1]) : '';
}

// Extract every <b>...</b> for cases where a single bullet mentions multiple
// entities (rare).
function allBolds(html) {
  const out = [];
  const re = /<b\b[^>]*>([\s\S]*?)<\/b>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(stripTags(m[1]));
  return out;
}

// Walk the HTML and split it on H2 boundaries — returns
// [{ id, title, html }, ...] for the top-level sections.
function splitH2Sections(html) {
  const re = /<h2\b[^>]*>(?:<span\b[^>]*\bid="([^"]+)"[^>]*>)?([\s\S]*?)<\/h2>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    marks.push({ id: m[1] || '', title: stripTags(m[2] || ''), start: m.index, headEnd: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const next = i + 1 < marks.length ? marks[i + 1].start : html.length;
    out.push({ id: marks[i].id, title: marks[i].title, html: html.slice(marks[i].headEnd, next) });
  }
  return out;
}

// Find every <details>...</details> block in an HTML chunk. Depth-tracks so
// nested details (rare) still parse correctly.
function extractDetailsBlocks(html) {
  const out = [];
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf('<details', pos);
    if (open === -1) break;
    let depth = 1, i = open + '<details'.length;
    while (depth > 0 && i < html.length) {
      const next  = html.indexOf('<details', i);
      const close = html.indexOf('</details>', i);
      if (close === -1) { i = html.length; break; }
      if (next !== -1 && next < close) { depth++; i = next + '<details'.length; }
      else                              { depth--; i = close + '</details>'.length; }
    }
    out.push(html.slice(open, i));
    pos = i;
  }
  return out;
}

// ── Per-patch parsing ────────────────────────────────────────────────────────

const VERSION_RE = /v\.?\s*(\d+)\.(\d+)(?:\.(\d+))?/;
const DATE_RE    = /(\d{4}-\d{2}-\d{2})/;

function parseSummary(detailsHtml) {
  const m = detailsHtml.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
  if (!m) return null;
  const text = stripTags(m[1]);
  const ver  = text.match(VERSION_RE);
  const date = text.match(DATE_RE);
  if (!ver) return null;
  const major = parseInt(ver[1], 10);
  const minor = parseInt(ver[2], 10);
  const patch = ver[3] != null ? parseInt(ver[3], 10) : 0;
  return {
    version:    `v${major}.${minor}${ver[3] != null ? '.' + patch : ''}`,
    versionTriple: [major, minor, patch],
    date:       date ? date[1] : '',
    summary:    text,
  };
}

// Split a details body into its <h4> sections. Returns
// [{ section, html }, ...] preserving the prose / lists under each heading.
function splitH4Sections(html) {
  const re = /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    marks.push({ name: stripTags(m[1]).replace(/[:\s]+$/,'').trim(), start: m.index, headEnd: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const next = i + 1 < marks.length ? marks[i + 1].start : html.length;
    out.push({ section: marks[i].name.toUpperCase(), html: html.slice(marks[i].headEnd, next) });
  }
  return out;
}

// Walk a section's HTML, yielding each top-level <li> with the "subsection"
// label that preceded it. Subsections come from inline <p><b>Foo:</b></p>
// markers (e.g., "Silent:", "Potions & Relics:", "Enemies:") that group
// changes by character / category within a section.
function* iterateBullets(sectionHtml) {
  let subsection = '';
  let pos = 0;
  while (pos < sectionHtml.length) {
    // Find the next <p ...> or <ul ...> opening tag
    const pIdx = sectionHtml.indexOf('<p', pos);
    const uIdx = sectionHtml.indexOf('<ul', pos);
    let next = -1, kind = null;
    if (pIdx === -1 && uIdx === -1) break;
    if (pIdx === -1 || (uIdx !== -1 && uIdx < pIdx)) { next = uIdx; kind = 'ul'; }
    else                                              { next = pIdx; kind = 'p'; }

    const chunk = balancedSpan(sectionHtml, next, kind);
    if (!chunk) break;

    if (kind === 'p') {
      // Use the chunk's first bold as a subsection label IF the paragraph is
      // basically just "Bold Label:" (a header), not body prose.
      const inner = chunk.replace(/^<p\b[^>]*>/i, '').replace(/<\/p>$/i, '');
      const text  = stripTags(inner);
      if (text.length < 60 && /:$/.test(text)) {
        subsection = text.replace(/:$/, '').trim();
      }
    } else {
      for (const li of topLevelLis(chunk)) {
        yield { subsection, liHtml: li };
      }
    }
    pos = next + chunk.length;
  }
}

// Walk forward from `start` (the position of `<tag` in `html`) and return the
// substring through the matching `</tag>`, depth-tracking nested same-tag
// pairs. Returns null on malformed input.
function balancedSpan(html, start, tag) {
  const openTag  = `<${tag}`;
  const closeTag = `</${tag}>`;
  if (html.slice(start, start + openTag.length).toLowerCase() !== openTag.toLowerCase()) return null;
  // Skip past the first opening tag's '>'
  const headEnd = html.indexOf('>', start);
  if (headEnd === -1) return null;
  let i = headEnd + 1;
  let depth = 1;
  while (depth > 0 && i < html.length) {
    const nextOpen  = html.toLowerCase().indexOf(openTag,  i);
    const nextClose = html.toLowerCase().indexOf(closeTag, i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Confirm it's really an opening (not just a substring)
      const ch = html[nextOpen + openTag.length];
      if (ch === ' ' || ch === '>' || ch === '\t' || ch === '\n') {
        depth++;
        i = nextOpen + openTag.length;
      } else {
        // false positive — treat as inert text and resume past it
        i = nextOpen + openTag.length;
      }
    } else {
      depth--;
      i = nextClose + closeTag.length;
    }
  }
  if (depth !== 0) return null;
  return html.slice(start, i);
}

// Given a <ul>...</ul> chunk, return the inner HTML of each direct <li>.
// (Walks with depth tracking so nested <ul>/<li> don't escape.)
function topLevelLis(ulHtml) {
  // Strip the outer <ul> tags.
  const inner = ulHtml.replace(/^<ul\b[^>]*>/i, '').replace(/<\/ul>$/i, '');
  const out = [];
  const re = /<(\/?)(li|ul|ol)[\s>]/gi;
  let depth = 0;       // nested <ul>/<ol> depth
  let liStart = -1;    // start of current top-level <li> content
  let liDepth = -1;    // ul-depth at the moment liStart was set
  let m;
  while ((m = re.exec(inner)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      if (!closing) depth++;
      else depth--;
    } else if (tag === 'li') {
      if (!closing) {
        if (depth === 0 && liStart === -1) {
          liStart = m.index;
          liDepth = depth;
        }
      } else if (liStart !== -1 && depth === liDepth) {
        const liChunk = inner.slice(liStart, m.index + m[0].length);
        out.push(liChunk);
        liStart = -1;
        liDepth = -1;
      }
    }
  }
  return out;
}

// Diff extraction. Patch notes use three styles:
//   1. `from X -> Y`     (numeric balance changes — "damage decreased from 7 -> 3")
//   2. `"X" -> "Y"`      (full description swaps in Reworks)
//   3. `Old: X / New: Y` (multi-line Reworked blocks — newlines flattened to ' | ')
const FROM_ARROW_RE  = /\bfrom\s+([^\s][^]*?)\s*(?:-&gt;|->|→)\s*([^.,;<]+?)(?=[.,;<]|$)/gi;
const QUOTED_ARROW_RE = /"([^"]+)"\s*(?:-&gt;|->|→)\s*"([^"]+)"/g;
const OLD_NEW_RE     = /Old:\s*([^|]*?)\s*\|\s*New:\s*([^|]+?)(?=\s*\||$)/gi;

function extractDiffs(text) {
  const out = [];
  for (const re of [FROM_ARROW_RE, QUOTED_ARROW_RE, OLD_NEW_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ from: m[1].trim(), to: m[2].trim() });
    }
  }
  return out;
}

// Heuristic verb detection: prefix word(s) before the bolded entity.
const VERBS = ['Buffed','Nerfed','Reworked','Reverted','Changed','Updated',
               'Added','Removed','Deprecated','Adjusted','Fixed','Renamed','Reduced','Increased'];

function detectVerb(text) {
  const m = text.match(/^\s*(\w+)\b/);
  if (!m) return null;
  const w = m[1];
  return VERBS.includes(w) ? w : null;
}

// Build a structured change record for a single <li>.
function parseChange(liHtml, ctx) {
  // Strip outer <li> if present.
  let inner = liHtml.replace(/^<li\b[^>]*>/i, '').replace(/<\/li>\s*$/i, '');

  // For the "raw" text we keep nested bullets readable by joining with " | ".
  const rawText = stripTags(
    inner.replace(/<\/li>\s*<li\b[^>]*>/gi, ' | ')
         .replace(/<ul\b[^>]*>/gi, ' [ ')
         .replace(/<\/ul>/gi, ' ]')
  );

  const entities = allBolds(inner);
  const entity   = entities[0] || '';
  const verb     = detectVerb(rawText);
  const diffs    = extractDiffs(inner);

  return {
    section:    ctx.section,
    subsection: ctx.subsection || '',
    verb,
    entity,
    entities,         // only set when >1 — useful for review
    diffs,            // [{ from, to }] arrow pairs
    raw:        rawText,
  };
}

// ── Version helpers ──────────────────────────────────────────────────────────

function compareVersions(a, b) {
  const [a1, a2, a3] = a;
  const [b1, b2, b3] = b;
  return (a1 - b1) || (a2 - b2) || (a3 - b3);
}

// ── Live-data lookup (for entity → category classification) ──────────────────

function normalizeName(s) {
  return String(s || '').toLowerCase()
    .replace(/[()'']/g, '')
    .replace(/[-_\/]/g, ' ')               // unify separators so wiki "Flick-Flack" matches data "Flick Flack"
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Categories tracked by kernels. Events / potions are deliberately omitted
// (their data doesn't drive any rendering decision the dashboard makes).
const KERNEL_CATEGORIES = ['cards', 'relics', 'enchantments'];

// Map of normalized-name → original-cased name (preserving "of" / "in" /
// "the" lowercase as the live data has them). The capitalize() fallback
// would otherwise mangle multi-word names like "Spoils of Battle" →
// "Spoils Of Battle", causing kernel keys to disagree with simplified-
// data keys downstream.
function loadLiveDataMaps() {
  const out = {};
  for (const cat of KERNEL_CATEGORIES) out[cat] = new Map();
  for (const cat of KERNEL_CATEGORIES) {
    const file = path.join(LIVE_DATA_DIR, cat + '.json');
    if (!fs.existsSync(file)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of arr) if (e && e.name) out[cat].set(normalizeName(e.name), e.name);
    } catch (e) {
      console.warn(`  (warning) could not read live ${cat}.json: ${e.message}`);
    }
  }
  return out;
}

// Try to map an entity name to one of the tracked categories. The first cat
// whose live JSON contains this name (with optional 'the ' prefix tolerance)
// wins. Returns null if no match — common for events / potions which we
// deliberately don't track, plus any new entity we haven't scraped yet.
function classifyEntity(name, live) {
  if (!name) return null;
  const norm = normalizeName(name);
  if (!norm) return null;
  for (const cat of KERNEL_CATEGORIES) {
    if (live[cat].has(norm)) return cat;
    if (live[cat].has('the ' + norm)) return cat;
    if (live[cat].has(norm.replace(/[:!.?]+$/, '').trim())) return cat;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${PATCH_PAGE} …`);
  const html = await fetchPageHtml(PATCH_PAGE);
  console.log(`  ${html.length} chars`);

  const sections = splitH2Sections(html);
  const wanted   = sections.filter(s =>
    s.id === 'Beta_Patches' || s.id === 'After_Early_Access');

  // Collect every patch entry from both sections.
  const rawPatches = [];
  for (const sec of wanted) {
    const blocks = extractDetailsBlocks(sec.html);
    console.log(`  ${sec.title}: ${blocks.length} patch entries`);
    for (const b of blocks) {
      const meta = parseSummary(b);
      if (!meta) continue;
      rawPatches.push({ ...meta, sourceSection: sec.title, html: b });
    }
  }

  // Merge same-version entries (Beta + After-EA can repeat a number; the
  // release roll-up subsumes the beta with the same number).
  const byVersion = new Map();
  for (const p of rawPatches) {
    if (!byVersion.has(p.version)) byVersion.set(p.version, p);
    else {
      const existing = byVersion.get(p.version);
      // Keep the non-Beta entry as primary if available; concatenate the
      // body so we don't lose anything. (After-EA dates are later.)
      const primary  = p.sourceSection === 'After Early Access' ? p : existing;
      const other    = primary === p ? existing : p;
      byVersion.set(p.version, {
        ...primary,
        html: primary.html + '\n<!-- merged from ' + other.sourceSection + ' -->\n' + other.html,
      });
    }
  }

  const patches = [...byVersion.values()]
    .sort((a, b) => compareVersions(a.versionTriple, b.versionTriple));

  console.log(`\nUnique versions (oldest → newest): ${patches.map(p => p.version).join(', ')}`);

  // Load live wiki data so we can route each change into the right category
  // (cards / relics / events / potions / enchantments). If live data isn't
  // on disk the parser still runs; everything just falls into `unknown[]`.
  const live = loadLiveDataMaps();
  const liveCounts = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v.size]));
  console.log(`\nLive data loaded for categorization: ${JSON.stringify(liveCounts)}`);

  // Build backward-delta kernels: one per consecutive-version pair. Each
  // kernel reverts FROM the later version TO the earlier one. Content =
  // the OLD (earlier-version) field values of entities that changed.
  const kernels = [];
  for (let i = 1; i < patches.length; i++) {
    const olderVersion = patches[i - 1];   // the "to" target when reverting
    const newerVersion = patches[i];       // the "from" source (this patch's release)
    const k = buildKernel(newerVersion, olderVersion, live);
    k.index = i - 1;
    kernels.push(k);
  }

  // Write everything.
  fs.mkdirSync(KERNEL_DIR, { recursive: true });

  const manifest = {
    scraped_at:    new Date().toISOString(),
    source:        `${WIKI_BASE}/wiki/${PATCH_PAGE}`,
    current_version: patches[patches.length - 1].version,
    versions:      patches.map((p, i) => ({
      version:     p.version,
      released_on: p.date,
      summary:     p.summary,
    })),
    kernel_notes: kernels.map(k => ({
      index:       k.index,
      from:        k.from,
      to:          k.to,
      file:        `kernel-notes/${kernelFilename(k)}`,
      released_on: k.released_on,
    })),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nWrote ${MANIFEST}`);

  for (const k of kernels) {
    const dest = path.join(KERNEL_DIR, kernelFilename(k));
    fs.writeFileSync(dest, JSON.stringify(k, null, 2), 'utf8');
    const cnt = KERNEL_CATEGORIES
      .map(c => `${Object.keys(k[c]).length}${c[0]}`)
      .join(' ');
    console.log(`  ${path.basename(dest)}  — ${cnt}`);
  }

  console.log(`\nDone. ${kernels.length} backward-delta kernel(s).`);
}

// "0. v0.98.2_to_v0.98.1.json" — leading numeric index for stable sort,
// then explicit from→to versions so the backward-revert direction is obvious.
function kernelFilename(k) {
  return `${k.index}. ${k.from}_to_${k.to}.json`;
}

// Build the backward-delta kernel for the patch that landed in `newer`. The
// kernel reverts to `older`. For every entity whose simplified-schema fields
// changed, lists only those fields with `{ old, new }` pairs. Anything the
// auto-extractor can't confidently classify is left blank — the raw bullet
// text(s) accumulate under `_source` as a hand-curation hint.
function buildKernel(newer, older, live) {
  const h4s = splitH4Sections(newer.html);

  const cards = {}, relics = {}, enchantments = {};
  const buckets = { cards, relics, enchantments };

  for (const sec of h4s) {
    const sectionName = sec.section.replace(/[:\s]+$/, '').trim();
    if (!RELEVANT_SECTIONS.has(sectionName)) continue;
    for (const { subsection, liHtml } of iterateBullets(sec.html)) {
      const change = parseChange(liHtml, { section: sectionName, subsection });
      if (!change.raw) continue;

      const cat = classifyEntity(change.entity, live);
      // Skip anything that doesn't classify into our 3 tracked categories
      // (events / potions / unknown intentionally dropped).
      if (!cat) continue;

      // Skip [Added] entries — a new entity didn't exist in older versions,
      // so saves from those versions can't reference it. The kernel doesn't
      // need to revert it backward (no-op for reconstruction).
      if (change.verb === 'Added') continue;

      const canonical = canonicalName(change.entity, live[cat]) || change.entity;
      const bucket = buckets[cat];
      if (!bucket[canonical]) bucket[canonical] = {};
      const entry = bucket[canonical];

      const sourceNote = `[${change.verb || '?'}] ${change.raw}`;
      entry._source = entry._source ? `${entry._source}\n${sourceNote}` : sourceNote;

      autoFillFields(entry, change, cat);
    }
  }

  return {
    from:        newer.version,    // we revert FROM this version
    to:          older.version,    // BACKWARDS to this version
    released_on: newer.date,
    summary:     newer.summary,
    cards, relics, enchantments,
  };
}

// Conservative auto-fill: only emit `{ old, new }` for fields where the wiki
// phrasing maps unambiguously to a simplified-schema key. Anything else is
// left blank for the user to fill in by hand (the raw bullet is in `_source`).
//
// Rules implemented:
//   - "rarity (...) from X -> Y"           → rarity:   { old: X, new: Y }
//   - "cost (decreased|increased|...) from N -> M"   → manaCost: { old: N, new: M }
//   - "renamed from \"X\" to \"Y\"" (or with arrow)  → name:     { old: X, new: Y }
//   - prose-length quoted "X" -> "Y" pair   → description: { old: X, new: Y }
//
// Numeric balance changes embedded in the description ("damage from 7 -> 6")
// are NOT auto-derived because reconstructing the full description requires
// the patch-version template, which we don't have. Those land in `_source`
// for the user to translate into a description diff manually.
function autoFillFields(entry, change, cat) {
  const raw = change.raw || '';

  const rarityM = raw.match(/rarity\s+(?:increased|decreased|changed)?\s*from\s+(\w+)\s*(?:->|→|-&gt;)\s*(\w+)/i);
  if (rarityM) entry.rarity = { old: rarityM[1], new: rarityM[2] };

  // "cost decreased from 2 -> 1", "mana cost from 3 -> 2", etc. Numeric values
  // only — reject when either side isn't a digit or the literal "X" so we
  // don't over-match descriptive prose. Also reject "Star cost" / "Stars cost"
  // (the [star:N] mechanic is unrelated to mana cost).
  const costM = raw.match(/(?:^|\s)(?<!star\s|stars\s)(?:mana\s+|energy\s+)?cost\s+(?:increased|decreased|changed)?\s*from\s+(X|\d+)\s*(?:->|→|-&gt;)\s*(X|\d+)/i);
  if (costM) {
    entry.manaCost = {
      old: costM[1] === 'X' ? -1 : parseInt(costM[1], 10),
      new: costM[2] === 'X' ? -1 : parseInt(costM[2], 10),
    };
  }

  const renameM = raw.match(/renamed\s+from\s+"([^"]+)"\s*(?:to|->|→|-&gt;)\s*"([^"]+)"/i);
  if (renameM) entry.name = { old: renameM[1], new: renameM[2] };

  // Full-text reworks: quoted prose-length "X" -> "Y" at the description level.
  for (const d of (change.diffs || [])) {
    if (!d.from || !d.to) continue;
    if (/[a-z]/i.test(d.from) && d.from.length > 20) {
      entry.description = { old: d.from, new: d.to };
      break;
    }
  }
}

// Find the canonical name as stored in the live data. The live map's value
// is the actual cards.json `name` field, so multi-word names with lowercase
// articles/prepositions ("Spoils of Battle") survive intact instead of
// getting butchered by a per-word capitalize.
function canonicalName(name, liveMap) {
  if (!name) return null;
  const tries = [name, name.replace(/[:!.?]+$/, '').trim()];
  for (const t of tries) {
    const n = normalizeName(t);
    if (liveMap.has(n))         return liveMap.get(n);
    if (liveMap.has('the ' + n)) return liveMap.get('the ' + n);
  }
  return null;
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
