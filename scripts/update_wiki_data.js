'use strict';
/**
 * update_wiki_data.js — Update STS2 stats JSON files and images from the wiki.
 * Runs as an Electron utilityProcess — no Python required.
 * Config is passed via the STS2_CONFIG environment variable (JSON).
 *
 * Equivalent to update_wiki_data.py.  All parsing logic is regex-based to
 * avoid any external npm dependencies (global fetch is available in Node 20+
 * which ships with Electron 29+).
 */

const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

// ── Configuration ──────────────────────────────────────────────────────────────

const cfg = JSON.parse(process.env.STS2_CONFIG || '{}');

const SCRIPT_DIR   = __dirname;
const DATA_DIR     = cfg.dataDir     || path.join(SCRIPT_DIR, '..', 'assets', 'data');
const IMAGES_DIR   = cfg.imagesDir   || path.join(SCRIPT_DIR, '..', 'assets', 'images');
const SETTINGS_DIR = cfg.settingsDir || path.join(SCRIPT_DIR, '..', 'assets', 'settings');
const WHAT         = cfg.what        || 'all';
const DRY_RUN      = cfg.dryRun      || false;
const FORCE_IMAGES = cfg.forceImages || false;

const WIKI_BASE = 'https://slaythespire.wiki.gg';

const WIKI_PAGES = {
  relics:       'Slay_the_Spire_2:Relics_List',
  enchantments: 'Slay_the_Spire_2:Enchantments',
  events:       'Slay_the_Spire_2:Events_List',
  cards:        'Slay_the_Spire_2:Cards_List',
  potions:      'Slay_the_Spire_2:Potions_List',
  map_icons:    'Category:Map_Icons',
};

const MAP_ICONS_META = path.join(SETTINGS_DIR, 'map_icons_meta.json');

const ENCHANT_HEADERS = {
  'name': 'name',
  'source type': 'sourceType', 'source': 'source',
  'target': 'targetCard',
  'description': 'description', 'effect': 'description', 'notes': 'description',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0';

// ── IPC / output ──────────────────────────────────────────────────────────────

function send(type, msg) {
  (type === 'stderr' ? process.stderr : process.stdout).write(String(msg) + '\n');
}

const log  = (msg) => send('stdout', String(msg));
const warn = (msg) => send('stderr', String(msg));

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (attempt < retries - 1) await sleep(1500);
      else throw new Error(`Failed after ${retries} attempts: ${e.message}`);
    }
  }
}

async function fetchPageHtml(pageName, retries = 3) {
  const encoded = encodeURIComponent(pageName).replace(/%3A/g, ':');
  const url = `${WIKI_BASE}/api.php?action=parse&page=${encoded}&prop=text&format=json&disableeditsection=true&disabletoc=true`;
  const data = await fetchJson(url, retries);
  if (data.error) throw new Error(`Wiki API error: ${data.error.info || JSON.stringify(data.error)}`);
  return data.parse.text['*'];
}

async function downloadImage(url, dest, force = false) {
  if (!url) return 'skip';
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'skip';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,*/*', 'Referer': WIKI_BASE + '/' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    return 'ok';
  } catch (e) {
    warn(`    ✗ download failed (${e.message}): ${path.basename(dest)}`);
    return 'fail';
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CONCURRENCY = 8; // max concurrent image downloads

// Run fn(item, index) for each item, at most `limit` at a time
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function fixName(s) {
  if (!s) return '';
  return s.trim().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(s) {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim();
}

function thumbToFull(url) {
  if (!url) return '';
  url = url.trim();
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = WIKI_BASE + url;
  const m = url.match(/^(https?:\/\/[^/]+)\/images\/thumb\/(.+)\/\d+px-[^/]+$/);
  if (m) return `${m[1]}/images/${m[2]}`;
  return url;
}

function decodeFilename(url) {
  try { return decodeURIComponent(path.basename(new URL(url).pathname)); }
  catch { return path.basename(url); }
}

// ── HTML tag stripper ─────────────────────────────────────────────────────────

function stripHtml(s) {
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<img\b[^>]*\/?>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Div-box parser (relics / cards / events layout) ──────────────────────────

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractBoxes(html, boxClass) {
  const boxes = [];
  const pat = new RegExp(`<div\\b[^>]*\\bclass="[^"]*\\b${escRe(boxClass)}\\b[^"]*"[^>]*>`, 'g');
  let m;
  while ((m = pat.exec(html)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < html.length) {
      const od = html.indexOf('<div', i);
      const cd = html.indexOf('</div>', i);
      if (cd === -1) { i = html.length; break; }
      if (od !== -1 && od < cd) { depth++; i = od + 4; }
      else { depth--; i = cd + 6; }
    }
    boxes.push(html.slice(m.index, i));
    pat.lastIndex = i;
  }
  return boxes;
}

function boxAttr(boxHtml, attr) {
  const root = boxHtml.match(/^<div\b([^>]*)>/);
  if (!root) return '';
  const v = root[1].match(new RegExp(`\\b${escRe(attr)}="([^"]*)"`));
  return v ? v[1] : '';
}

function innerHtml(html, className) {
  const m = html.match(new RegExp(`class="[^"]*${escRe(className)}[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:div|span)>`));
  return m ? m[1] : '';
}

function innerText(html, className) { return stripHtml(innerHtml(html, className)); }

function extractName(box, titleClass) {
  const titleHtml = innerHtml(box, titleClass);
  let text = stripHtml(titleHtml);
  if (!text) {
    const m = titleHtml.match(/\btitle="([^"]+)"/);
    if (m) {
      const raw = m[1];
      text = raw.includes(':') ? raw.split(':').slice(1).join(':').trim() : raw.trim();
    }
    if (text) log(`    ⚠ blank title text — used <a title> fallback: ${JSON.stringify(text)}`);
    else       log('    ⚠ could not extract name from box (skipping)');
  }
  return fixName(text);
}

function firstWikiHref(html) {
  const m = html.match(/href="(\/wiki\/[^"#]+)"/);
  return m ? WIKI_BASE + m[1] : '';
}

function firstImgIn(html, spanClass) {
  const span = html.match(new RegExp(`class="[^"]*${escRe(spanClass)}[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`));
  if (!span) return '';
  const img = span[1].match(/<img\b[^>]*(?:src|data-src|data-lazy-src)="([^"]+)"/);
  return img ? img[1] : '';
}

function makeImgPair(url) {
  const full = thumbToFull(url);
  if (!full) return ['', ''];
  return [full, decodeFilename(full)];
}

// ── HTML table parser (enchantments layout) ───────────────────────────────────

function parseTables(html) {
  const tables = [];
  let pos = 0;
  while (pos < html.length) {
    const tOpen = html.indexOf('<table', pos);
    if (tOpen === -1) break;
    // Find matching </table> with depth tracking
    let depth = 1, i = tOpen + 6;
    while (depth > 0 && i < html.length) {
      const next = html.indexOf('<table', i);
      const close = html.indexOf('</table>', i);
      if (close === -1) { i = html.length; break; }
      if (next !== -1 && next < close) { depth++; i = next + 6; }
      else { depth--; i = close + 8; }
    }
    const tableHtml = html.slice(tOpen, i);
    const rows = parseTableRows(tableHtml);
    if (rows.length) tables.push(rows);
    pos = i;
  }
  return tables;
}

function parseTableRows(tableHtml) {
  // Walk the outer table's direct <tr> children only (skip nested tables)
  const rows = [];
  const re = /<(\/?)(table|tr)[\s>]/gi;
  let depth = 0, rowStart = -1;
  let m;
  while ((m = re.exec(tableHtml)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      if (!closing) depth++;
      else depth--;
    } else if (tag === 'tr' && depth === 1) {
      if (!closing) {
        rowStart = m.index;
      } else if (rowStart >= 0) {
        const cells = parseCells(tableHtml.slice(rowStart, m.index + m[0].length));
        if (cells.length) rows.push(cells);
        rowStart = -1;
      }
    }
  }
  return rows;
}

function parseCells(rowHtml) {
  const cells = [];
  let tableDepth = 0;
  let cellStart = -1;
  const re = /<(\/?)(table|t[dh])[\s>]/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      if (!closing) tableDepth++;
      else tableDepth--;
    } else if (tableDepth === 0) {
      if (!closing) {
        cellStart = m.index;
      } else if (cellStart >= 0) {
        const cellHtml = rowHtml.slice(cellStart, m.index + m[0].length);
        const gtIdx = cellHtml.indexOf('>');
        const content = gtIdx >= 0 ? cellHtml.slice(gtIdx + 1) : '';
        cells.push({
          text: stripHtml(content),
          href: (content.match(/href="(?!#)([^"]+)"/) || [])[1] || null,
          img:  (content.match(/\b(?:src|data-src|data-lazy-src)="([^"]+)"/) || [])[1] || null,
        });
        cellStart = -1;
      }
    }
  }
  return cells;
}

// ── Header-based column mapping ───────────────────────────────────────────────

function mapHeaders(headerRow, fieldMap) {
  const sortedKeys = Object.keys(fieldMap).sort((a, b) => b.length - a.length);
  const result = {};
  for (let i = 0; i < headerRow.length; i++) {
    const text = cleanText(headerRow[i].text).toLowerCase();
    // Treat empty, "icon", "image", or "img" headers as the image column
    if (!text || text === 'icon' || text === 'image' || text === 'img') {
      result[i] = 'img';
      continue;
    }
    const match = sortedKeys.find(kw => text.includes(kw));
    result[i] = match ? fieldMap[match] : `_col${i}`;
  }
  return result;
}

function extractTableRows(tables, fieldMap, requiredFields = ['name']) {
  for (const table of tables) {
    if (table.length < 2) continue;
    for (let hdrIdx = 0; hdrIdx < Math.min(3, table.length); hdrIdx++) {
      const colMap = mapHeaders(table[hdrIdx], fieldMap);
      const vals = Object.values(colMap);
      if (!requiredFields.every(f => vals.includes(f))) continue;
      const rows = [];
      for (const row of table.slice(hdrIdx + 1)) {
        const rec = {};
        for (let ci = 0; ci < row.length; ci++) {
          const cell = row[ci];
          const field = colMap[ci] || `_col${ci}`;
          if (field === 'img') {
            if (cell.img && !rec.img) {
              const full = thumbToFull(cell.img);
              rec.img = full;
              rec.imgFile = decodeFilename(full);
            }
          } else if (!field.startsWith('_')) {
            let val = cleanText(cell.text);
            if (field === 'name') val = fixName(val);
            if (val && !(field in rec)) rec[field] = val;
          }
          if (cell.href && !rec.href) rec.href = cell.href;
        }
        if (rec.name) rows.push(rec);
      }
      if (rows.length) return [rows, colMap];
    }
  }
  return [[], {}];
}

// ── Diff / merge ──────────────────────────────────────────────────────────────

function diffEntries(oldList, newList, key = 'name') {
  const oldMap = Object.fromEntries(oldList.filter(e => e[key]).map(e => [e[key], e]));
  const newMap = Object.fromEntries(newList.filter(e => e[key]).map(e => [e[key], e]));
  const added   = Object.keys(newMap).filter(k => !(k in oldMap)).map(k => newMap[k]);
  const removed = Object.keys(oldMap).filter(k => !(k in newMap)).map(k => oldMap[k]);
  const changed = [];
  for (const k of Object.keys(oldMap)) {
    if (!(k in newMap)) continue;
    const [o, n] = [oldMap[k], newMap[k]];
    const diffs = Object.keys(n).filter(fk => n[fk] && n[fk] !== o[fk]);
    if (diffs.length) changed.push([o, n, diffs]);
  }
  return [added, changed, removed];
}

function mergeEntries(oldList, added, changed, key = 'name') {
  const merged = Object.fromEntries(oldList.map(e => [e[key], { ...e }]));
  for (const n of added) merged[n[key]] = n;
  for (const [o, n] of changed) {
    const entry = { ...o };
    for (const [k, v] of Object.entries(n)) { if (v) entry[k] = v; }
    merged[n[key]] = entry;
  }
  return Object.values(merged);
}

// ── Shared image downloader ───────────────────────────────────────────────────

async function syncImages(toDl, imagesDir, forceImages, dryRun, forceNames = new Set()) {
  const valid = toDl.filter(([u, f]) => u && f);
  if (!valid.length) return;
  const need = valid.filter(([, f]) => {
    const dest = path.join(imagesDir, f);
    return forceImages || forceNames.has(f) || !fs.existsSync(dest) || fs.statSync(dest).size === 0;
  });
  const already = valid.length - need.length;
  if (already)    log(`  Images: ${already} already on disk, skipped`);
  const refreshed = need.filter(([, f]) => forceNames.has(f) && !forceImages).length;
  if (refreshed)  log(`  Images: ${refreshed} flagged for refresh (entry data changed)`);
  if (!need.length) return;
  log(`  Images: downloading ${need.length}`);
  if (dryRun) { for (const [, f] of need) log(`    [dry] ${f}`); return; }
  let ok = 0, fail = 0, done = 0;
  await withConcurrency(need, CONCURRENCY, async ([url, fname]) => {
    const force = forceImages || forceNames.has(fname);
    const result = await downloadImage(url, path.join(imagesDir, fname), force);
    done++;
    log(`    [${done}/${need.length}] ${result === 'ok' ? '✓' : result === 'skip' ? '–' : '✗'} ${fname}`);
    if (result === 'ok') ok++;
    else if (result === 'fail') fail++;
  });
  log(`  Images done: ${ok} downloaded, ${fail} failed`);
}

// ── Shared report + write ─────────────────────────────────────────────────────

function reportAndWrite(existing, newEntries, jsonPath, dryRun, key = 'name', preserveKeys = []) {
  const [added, changed, removed] = diffEntries(existing, newEntries, key);
  log(`  + ${added.length} new   ~ ${changed.length} changed   - ${removed.length} removed (kept in JSON)`);
  for (const n of added)           log(`    + ${n[key]}`);
  for (const [, n, diffs] of changed) log(`    ~ ${n[key]}: ${diffs.join(', ')}`);
  for (const o of removed)         log(`    - ${o[key]}  ← no longer on wiki, kept for old runs`);
  const dirtyKeys = new Set([...added.map(n => n[key]), ...changed.map(([, n]) => n[key])]);
  if (dryRun) { log('  [dry-run] no files written'); return dirtyKeys; }
  let final = mergeEntries(existing, added, changed, key);
  if (preserveKeys.length) {
    const oldMap = Object.fromEntries(existing.map(e => [e[key], e]));
    for (const entry of final) {
      const old = oldMap[entry[key]] || {};
      for (const pk of preserveKeys) if (pk in old && !entry[pk]) entry[pk] = old[pk];
    }
  }
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(final, null, 2), 'utf8');
  log(`  ✓ Wrote ${final.length} entries → ${path.basename(jsonPath)}`);
  return dirtyKeys;
}

// ── Per-dataset updaters ──────────────────────────────────────────────────────

async function updateRelics(html) {
  log('\n━━━ RELICS ━━━');
  const jsonPath  = path.join(DATA_DIR,   'relics.json');
  const imagesDir = path.join(IMAGES_DIR, 'relic_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const existing = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : [];

  if (!html) { log('  ✗ No HTML available (fetch failed earlier)'); return; }

  const boxes = extractBoxes(html, 'relic-box');
  if (!boxes.length) { log('  ✗ No relic-box elements found. Wiki may have restructured.'); return; }
  log(`  Found ${boxes.length} relic boxes`);

  const newEntries = [];
  for (const box of boxes) {
    const name = extractName(box, 'relic-title');
    if (!name) continue;
    const [imgUrl, imgFile] = makeImgPair(firstImgIn(box, 'img-base'));
    const outerDesc = innerHtml(box, 'relic-desc');
    const description = stripHtml(innerHtml(outerDesc, 'relic-desc')) || stripHtml(outerDesc);
    newEntries.push({
      name,
      rarity:      boxAttr(box, 'data-rarity'),
      character:   boxAttr(box, 'data-character'),
      description,
      flavor:      innerText(box, 'relic-flavor'),
      link:        firstWikiHref(box),
      image:       imgUrl,
      imageFile:   imgFile,
    });
    log(`  item [${newEntries.length}]`);
  }

  const dirty = reportAndWrite(existing, newEntries, jsonPath, DRY_RUN);
  const forceNames = new Set(newEntries.filter(e => dirty.has(e.name) && e.imageFile).map(e => e.imageFile));
  await syncImages(newEntries.map(e => [e.image, e.imageFile]), imagesDir, FORCE_IMAGES, DRY_RUN, forceNames);
}

async function updateCards(html) {
  log('\n━━━ CARDS ━━━');
  const jsonPath  = path.join(DATA_DIR,   'cards.json');
  const imagesDir = path.join(IMAGES_DIR, 'card_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const existing = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : [];

  if (!html) { log('  ✗ No HTML available (fetch failed earlier)'); return; }

  const boxes = extractBoxes(html, 'card-box');
  if (!boxes.length) { log('  ✗ No card-box elements found. Wiki may have restructured.'); return; }
  log(`  Found ${boxes.length} card boxes`);

  const newEntries = [];
  for (const box of boxes) {
    const name = extractName(box, 'card-title');
    if (!name) continue;
    const [imgUrl, imgFile]       = makeImgPair(firstImgIn(box, 'img-base'));
    const [imgUpgUrl, imgUpgFile] = makeImgPair(firstImgIn(box, 'img-upg'));
    const cardDesc = innerHtml(box, 'card-desc');
    newEntries.push({
      name,
      character:           boxAttr(box, 'data-color'),
      rarity:              boxAttr(box, 'data-rarity'),
      type:                boxAttr(box, 'data-type'),
      canUpgrade:          boxAttr(box, 'data-canupgrade').toLowerCase() !== 'false',
      multiplayer:         boxAttr(box, 'data-multiplayer').toLowerCase() === 'true',
      link:                firstWikiHref(box),
      description:         stripHtml(innerHtml(cardDesc, 'desc-base')),
      descriptionUpgraded: stripHtml(innerHtml(cardDesc, 'desc-upg')),
      image:               imgUrl,
      imageFile:           imgFile,
      imageUpgraded:       imgUpgUrl,
      imageFileUpgraded:   imgUpgFile,
    });
    log(`  item [${newEntries.length}]`);
  }

  log(`  Total unique cards: ${newEntries.length}`);
  const dirty = reportAndWrite(existing, newEntries, jsonPath, DRY_RUN, 'name', ['canUpgrade', 'multiplayer']);
  const forceNames = new Set();
  for (const e of newEntries) {
    if (dirty.has(e.name)) {
      if (e.imageFile)        forceNames.add(e.imageFile);
      if (e.imageFileUpgraded) forceNames.add(e.imageFileUpgraded);
    }
  }
  const toDl = [
    ...newEntries.filter(e => e.image).map(e => [e.image, e.imageFile]),
    ...newEntries.filter(e => e.imageUpgraded).map(e => [e.imageUpgraded, e.imageFileUpgraded]),
  ];
  await syncImages(toDl, imagesDir, FORCE_IMAGES, DRY_RUN, forceNames);
}

async function updateEnchantments(html) {
  log('\n━━━ ENCHANTMENTS ━━━');
  const jsonPath  = path.join(DATA_DIR,   'enchantments.json');
  const imagesDir = path.join(IMAGES_DIR, 'enchantment_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const existing = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : [];

  if (!html) { log('  ✗ No HTML available (fetch failed earlier)'); return; }

  const tables = parseTables(html);
  const [rows] = extractTableRows(tables, ENCHANT_HEADERS, ['name']);
  if (!rows.length) {
    log('  ✗ No enchantments table found.');
    debugTables(html); return;
  }
  log(`  Scraped ${rows.length} enchantments`);

  const newEntries = [];
  for (const r of rows) {
    let href = r.href || '';
    if (href && !href.startsWith('http')) href = WIKI_BASE + href;
    newEntries.push({
      id:          r.name.replace(/ /g, '_'),
      name:        r.name,
      source:      r.source      || '',
      sourceType:  r.sourceType  || '',
      targetCard:  r.targetCard  || '',
      description: r.description || '',
      image:       r.img         || '',
      imageFile:   r.imgFile     || '',
    });
    log(`  item [${newEntries.length}]`);
  }

  const dirty = reportAndWrite(existing, newEntries, jsonPath, DRY_RUN);
  const forceNames = new Set(newEntries.filter(e => dirty.has(e.name) && e.imageFile).map(e => e.imageFile));
  await syncImages(newEntries.map(e => [e.image, e.imageFile]), imagesDir, FORCE_IMAGES, DRY_RUN, forceNames);
}

async function updateEvents(html) {
  log('\n━━━ EVENTS ━━━');
  const jsonPath  = path.join(DATA_DIR,   'events.json');
  const imagesDir = path.join(IMAGES_DIR, 'event_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const existing = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : [];

  if (!html) { log('  ✗ No HTML available (fetch failed earlier)'); return; }

  const boxes = extractBoxes(html, 'event-box');
  if (!boxes.length) { log('  ✗ No event-box elements found. Wiki may have restructured.'); return; }
  log(`  Found ${boxes.length} event boxes`);

  const newEntries = [];
  for (const box of boxes) {
    const name = extractName(box, 'event-title');
    if (!name) continue;
    const [imgUrl, imgFile] = makeImgPair(firstImgIn(box, 'img-base'));
    const acts = [...innerHtml(box, 'event-meta').matchAll(/data-act="([^"]+)"/g)]
      .map(m => m[1]).filter(Boolean);
    newEntries.push({
      name,
      acts,
      isShrine:    boxAttr(box, 'data-shrine').toLowerCase() === 'true',
      description: innerText(box, 'event-desc'),
      flavor:      innerText(box, 'event-flavor'),
      link:        firstWikiHref(box),
      image:       imgUrl,
      imageFile:   imgFile,
    });
    log(`  item [${newEntries.length}]`);
  }

  const dirty = reportAndWrite(existing, newEntries, jsonPath, DRY_RUN);
  const forceNames = new Set(newEntries.filter(e => dirty.has(e.name) && e.imageFile).map(e => e.imageFile));
  await syncImages(newEntries.map(e => [e.image, e.imageFile]), imagesDir, FORCE_IMAGES, DRY_RUN, forceNames);
}

async function updatePotions(html) {
  log('\n━━━ POTIONS ━━━');
  const jsonPath  = path.join(DATA_DIR,   'potions.json');
  const imagesDir = path.join(IMAGES_DIR, 'potion_images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const existing = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : [];

  if (!html) { log('  ✗ No HTML available (fetch failed earlier)'); return; }

  const boxes = extractBoxes(html, 'potion-box');
  if (!boxes.length) { log('  ✗ No potion-box elements found. Wiki may have restructured.'); return; }
  log(`  Found ${boxes.length} potion boxes`);

  const newEntries = [];
  for (const box of boxes) {
    const name = extractName(box, 'potion-title');
    if (!name) continue;
    const [imgUrl, imgFile] = makeImgPair(firstImgIn(box, 'img-base'));
    newEntries.push({
      name,
      rarity:      boxAttr(box, 'data-rarity'),
      character:   boxAttr(box, 'data-character'),
      description: innerText(box, 'potion-desc'),
      link:        firstWikiHref(box),
      image:       imgUrl,
      imageFile:   imgFile,
    });
    log(`  item [${newEntries.length}]`);
  }

  const dirty = reportAndWrite(existing, newEntries, jsonPath, DRY_RUN);
  const forceNames = new Set(newEntries.filter(e => dirty.has(e.name) && e.imageFile).map(e => e.imageFile));
  await syncImages(newEntries.map(e => [e.image, e.imageFile]), imagesDir, FORCE_IMAGES, DRY_RUN, forceNames);
}

async function updateMapIcons() {
  log('\n━━━ MAP ICONS ━━━');
  const iconsDir = path.join(IMAGES_DIR, 'map_icons');
  fs.mkdirSync(iconsDir,     { recursive: true });
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });

  let storedHashes = {};
  try {
    if (fs.existsSync(MAP_ICONS_META))
      storedHashes = JSON.parse(fs.readFileSync(MAP_ICONS_META, 'utf8'));
  } catch (_) {}

  // Step 1: list category members
  const listUrl = `${WIKI_BASE}/api.php?action=query&list=categorymembers` +
    `&cmtitle=${encodeURIComponent(WIKI_PAGES.map_icons).replace(/%3A/g, ':')}` +
    `&cmtype=file&cmlimit=500&format=json`;
  let members;
  try {
    const data = await fetchJson(listUrl);
    members = data.query.categorymembers;
  } catch (e) { log(`  ✗ Failed to list category: ${e.message}`); return; }

  if (!members.length) { log('  ✗ No files found in category.'); return; }
  log(`  Found ${members.length} icons in category`);

  // Step 2: batch-resolve direct image URLs
  const icons = {};
  const batchSize = 50;
  for (let i = 0; i < members.length; i += batchSize) {
    const batch = members.slice(i, i + batchSize).map(m => m.title);
    const titlesParam = batch.map(t => encodeURIComponent(t).replace(/%3A/g, ':')).join('|');
    const infoUrl = `${WIKI_BASE}/api.php?action=query&titles=${titlesParam}&prop=imageinfo&iiprop=url&format=json`;
    try {
      const infoData = await fetchJson(infoUrl);
      for (const page of Object.values(infoData.query.pages)) {
        const rawUrl = page.imageinfo?.[0]?.url || '';
        if (!rawUrl) continue;
        const [clean, hashval] = rawUrl.split('?');
        const fname = decodeFilename(clean);
        icons[fname] = [clean, hashval || ''];
      }
    } catch (e) { log(`  ✗ Batch imageinfo failed: ${e.message}`); }
  }

  log(`  Resolved ${Object.keys(icons).length} URLs`);

  // Step 3: determine what needs downloading
  const newIcons     = Object.keys(icons).filter(f => !fs.existsSync(path.join(iconsDir, f)));
  const updatedIcons = Object.keys(icons).filter(f =>
    !newIcons.includes(f) && icons[f][1] && storedHashes[f] !== icons[f][1]);
  const unchanged = Object.keys(icons).length - newIcons.length - updatedIcons.length;

  if (unchanged)         log(`  Images: ${unchanged} unchanged`);
  if (updatedIcons.length) {
    log(`  Images: ${updatedIcons.length} updated on wiki → re-downloading`);
    for (const f of updatedIcons) log(`    ~ ${f}`);
  }
  if (newIcons.length) {
    log(`  Images: ${newIcons.length} new`);
    for (const f of newIcons) log(`    + ${f}`);
  }

  const toRefresh = new Set([...newIcons, ...updatedIcons]);
  if (!toRefresh.size && !FORCE_IMAGES) { log('  Nothing to download.'); return; }

  const toDl = Object.entries(icons)
    .filter(([fname]) => FORCE_IMAGES || toRefresh.has(fname))
    .map(([fname, [url]]) => [url, fname]);
  log(`  Downloading ${toDl.length} icon(s)`);

  if (DRY_RUN) { for (const [, fname] of toDl) log(`    [dry] ${fname}`); return; }

  const newHashes = { ...storedHashes };
  let ok = 0, fail = 0, done = 0;
  await withConcurrency(toDl, CONCURRENCY, async ([url, fname]) => {
    const result = await downloadImage(url, path.join(iconsDir, fname), true);
    done++;
    log(`    [${done}/${toDl.length}] ${result === 'ok' ? '✓' : '✗'} ${fname}`);
    if (result === 'ok') { ok++; newHashes[fname] = icons[fname][1]; }
    else fail++;
  });
  fs.writeFileSync(MAP_ICONS_META, JSON.stringify(newHashes, null, 2), 'utf8');
  log(`  Images done: ${ok} downloaded, ${fail} failed`);
}

// ── Debug helper ──────────────────────────────────────────────────────────────

function debugTables(html) {
  const tables = parseTables(html);
  if (!tables.length) { log('  DEBUG: no <table> elements found in page HTML'); return; }
  log(`  DEBUG: found ${tables.length} table(s)`);
  for (let ti = 0; ti < tables.length; ti++) {
    if (!tables[ti].length) continue;
    const hdr = tables[ti][0].map(c => cleanText(c.text).slice(0, 20));
    log(`    table[${ti}] — ${tables[ti].length} rows, headers: [${hdr.join(', ')}]`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  log('Connecting to wiki…');
  if (DRY_RUN) log('DRY RUN — JSON files and images will NOT be modified\n');

  // Fetch the 4 main wiki pages in parallel (map_icons uses its own API calls)
  const pageKeys = ['relics', 'cards', 'enchantments', 'events', 'potions'];
  const fetchTargets = WHAT === 'all' ? pageKeys : pageKeys.filter(k => k === WHAT);

  const htmlMap = {};
  if (fetchTargets.length) {
    log(`Fetching ${fetchTargets.length} wiki page(s) in parallel…`);
    await withConcurrency(fetchTargets, fetchTargets.length, async (key) => {
      try {
        htmlMap[key] = await fetchPageHtml(WIKI_PAGES[key]);
        log(`  ✓ Fetched ${key}`);
      } catch (e) {
        htmlMap[key] = null;
        warn(`  ✗ Failed to fetch ${key}: ${e.message}`);
      }
    });
  }

  if (WHAT === 'all' || WHAT === 'relics')       await updateRelics(htmlMap.relics);
  if (WHAT === 'all' || WHAT === 'cards')        await updateCards(htmlMap.cards);
  if (WHAT === 'all' || WHAT === 'enchantments') await updateEnchantments(htmlMap.enchantments);
  if (WHAT === 'all' || WHAT === 'events')       await updateEvents(htmlMap.events);
  if (WHAT === 'all' || WHAT === 'potions')      await updatePotions(htmlMap.potions);
  if (WHAT === 'all' || WHAT === 'map_icons')    await updateMapIcons();

  log('\n✓ Done.');
  process.exit(0);
}

main().catch(e => { warn(e.stack || e.message); process.exit(1); });
