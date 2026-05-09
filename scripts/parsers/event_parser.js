'use strict';
/**
 * event_parser.js — JS port of
 *   spire-codex/backend/app/parsers/event_parser.py
 *
 * Reads:
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Events/*.cs
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Acts/*.cs   (act → event mapping)
 *   <raw>/localization/<lang>/{events,ancients,cards,relics,potions,enchantments,powers}.json
 *
 * Each event record has: id, name, type (Event/Ancient/Shared), act,
 * description, preconditions, options[], pages[] (multi-page trees), and
 * — for Ancient events — epithet, dialogue (per character), image, relics.
 *
 * Includes the per-event "fix" passes from spire-codex that resolve
 * runtime-computed values (Slippery Bridge escalating damage, Tablet of
 * Truth costs, Battleworn Dummy HP, etc.) where the localization templates
 * can't be filled in by static analysis alone.
 */

const fs   = require('fs');
const path = require('path');
const { resolveDescription, extractVarsFromSource } = require('./description_resolver.js');
const { resolveNamespaceDir } = require('./source_layout.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function classNameToId(name) {
  let s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  s = s.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
  return s.toUpperCase();
}

function readJsonOrEmpty(filepath) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { console.warn(`  could not parse ${filepath}: ${e.message}`); }
  return {};
}

function loadLocalization(locDir) {
  const loc = {};
  for (const fname of ['events.json', 'ancients.json']) {
    Object.assign(loc, readJsonOrEmpty(path.join(locDir, fname)));
  }
  return loc;
}

// Strip non-renderable rich text tags but preserve color/effect tags the
// frontend can render.
function stripRichTags(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[rainbow[^\]]*\]/g, '')
    .replace(/\[font_size=\d+\]/g, '')
    .replace(/\[\/?(?:thinky_dots|i|font_size|rainbow)\]/g, '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imageNameIfExists(dir, base) {
  if (!dir) return null;
  for (const ext of ['webp', 'png']) {
    const fp = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(fp)) return `${base}.${ext}`;
  }
  return null;
}

// Find substring of `s` from `startIdx` (which points at '{') through its
// matching '}', returning the index AFTER the closing brace, or -1 if
// unbalanced. Used for body-of-method extraction.
function findBlockEnd(s, startIdx) {
  if (s[startIdx] !== '{') return -1;
  let depth = 1, i = startIdx + 1;
  while (i < s.length && depth > 0) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

// ── Acts → events mapping ───────────────────────────────────────────────────

function buildActMapping(actsDir) {
  const ACT_MAP = {
    'Overgrowth.cs':  'Act 1 - Overgrowth',
    'Hive.cs':        'Act 2 - Hive',
    'Glory.cs':       'Act 3 - Glory',
    'Underdocks.cs':  'Underdocks',
  };
  const eventToActs = {};
  if (!fs.existsSync(actsDir)) return {};
  for (const [filename, actName] of Object.entries(ACT_MAP)) {
    const fp = path.join(actsDir, filename);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    for (const m of content.matchAll(/ModelDb\.Event<(\w+)>\(\)/g)) {
      if (!eventToActs[m[1]]) eventToActs[m[1]] = [];
      if (!eventToActs[m[1]].includes(actName)) eventToActs[m[1]].push(actName);
    }
    for (const m of content.matchAll(/ModelDb\.AncientEvent<(\w+)>\(\)/g)) {
      if (!eventToActs[m[1]]) eventToActs[m[1]] = [];
      if (!eventToActs[m[1]].includes(actName)) eventToActs[m[1]].push(actName);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(eventToActs)) out[k] = v.join(' / ');
  return out;
}

// ── Title map across all entity loc tables ──────────────────────────────────

function loadAllTitles(locDir) {
  const titles = {};
  for (const fname of ['cards.json', 'relics.json', 'potions.json', 'enchantments.json', 'powers.json']) {
    const data = readJsonOrEmpty(path.join(locDir, fname));
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith('.title')) titles[key.slice(0, -'.title'.length)] = value;
    }
  }
  return titles;
}

// ── Event-specific var extraction (heavier than generic extractVarsFromSource) ─

function extractEventVars(content, titleMap, relicDescs) {
  const vars = {};

  // const int fields: private const int _foo = 50;
  for (const m of content.matchAll(/const\s+int\s+_?(\w+)\s*=\s*(\d+)/g)) {
    vars[m[1]] = parseInt(m[2], 10);
  }
  // new DynamicVar("Name", 50m)
  for (const m of content.matchAll(/new\s+DynamicVar\("(\w+)",\s*(\d+)m?\)/g)) {
    vars[m[1]] = parseInt(m[2], 10);
  }
  // new XxxVar("Name", N) — typed named vars
  for (const m of content.matchAll(/new\s+\w+Var\(\s*"(\w+)"\s*,\s*(\d+)m?\s*(?:,\s*[^)]+)?\)/g)) {
    vars[m[1]] = parseInt(m[2], 10);
  }
  // new XxxVar(N) — unnamed typed; key by type
  for (const m of content.matchAll(/new\s+(\w+)Var\((\d+)m?\s*(?:,\s*[^)]+)?\)/g)) {
    if (!(m[1] in vars)) vars[m[1]] = parseInt(m[2], 10);
  }

  // Pre-extract array literals (string or numeric) — used for indexed var refs
  const arrays = {};
  const arrRe = /(?:static|readonly)\s+(?:.*?)(?:string|int|decimal)\[\]\s+(_\w+)\s*=\s*(?:new\s+\w+\[\d*\]\s*\{|new\s*\[\]\s*\{|\{)\s*([^}]+)\}/g;
  for (const m of content.matchAll(arrRe)) {
    const arrName = m[1], raw = m[2];
    if (raw.includes('"')) {
      arrays[arrName] = raw.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    } else {
      arrays[arrName] = raw.split(',')
        .map(v => v.trim().replace(/m$/, ''))
        .filter(v => /^\d+$/.test(v))
        .map(v => parseInt(v, 10));
    }
  }
  // Indexed var refs: new XxxVar(_keys[i], _vals[i])
  for (const m of content.matchAll(/new\s+\w+Var\((_\w+)\[(\d+)\]\s*,\s*(_\w+)\[(\d+)\]\)/g)) {
    const keyArr = m[1], keyIdx = +m[2], valArr = m[3], valIdx = +m[4];
    const keys = arrays[keyArr] || [];
    const vals = arrays[valArr] || [];
    if (keyIdx < keys.length && valIdx < vals.length) {
      vars[keys[keyIdx]] = vals[valIdx];
    }
  }

  // CalculateVars() body — Rng.NextInt(...) range patterns
  const calcM = content.match(/CalculateVars\(\)\s*\{([\s\S]*?)\n\s*\}/);
  if (calcM) {
    const body = calcM[1];
    const dvFrag = '(?:base\\.)?DynamicVars(?:\\["(\\w+)"\\]|\\.(\\w+))';

    // = Rng.NextInt(min, max)
    for (const rm of body.matchAll(new RegExp(dvFrag + '\\.BaseValue\\s*=\\s*(?:base\\.)?Rng\\.NextInt\\((-?\\d+),\\s*(-?\\d+)\\)', 'g'))) {
      const name = rm[1] || rm[2];
      const low = parseInt(rm[3], 10), high = parseInt(rm[4], 10) - 1;
      vars[name] = `${low}-${high}`;
    }
    // += (decimal)Rng.NextInt(min, max)
    for (const rm of body.matchAll(new RegExp(dvFrag + '\\.BaseValue\\s*\\+=\\s*\\(decimal\\)\\s*(?:base\\.)?Rng\\.NextInt\\((-?\\d+),\\s*(-?\\d+)\\)', 'g'))) {
      const name = rm[1] || rm[2];
      const base = vars[name];
      if (typeof base === 'number') {
        const low = parseInt(rm[3], 10), high = parseInt(rm[4], 10) - 1;
        vars[name] = `${base + low}-${base + high}`;
      }
    }
    // += (decimal)(Rng.NextInt(range) - offset)
    for (const rm of body.matchAll(new RegExp(dvFrag + '\\.BaseValue\\s*\\+=\\s*\\(decimal\\)\\s*\\(\\s*(?:base\\.)?Rng\\.NextInt\\((\\d+)\\)\\s*-\\s*(\\d+)\\s*\\)', 'g'))) {
      const name = rm[1] || rm[2];
      const base = vars[name];
      if (typeof base === 'number') {
        const rngMax = parseInt(rm[3], 10), offset = parseInt(rm[4], 10);
        vars[name] = `${base - offset}-${base + rngMax - offset - 1}`;
      }
    }
    // += (decimal)Rng.NextFloat(-N, N)
    for (const rm of body.matchAll(new RegExp(dvFrag + '\\.BaseValue\\s*\\+=\\s*\\(decimal\\)\\s*(?:base\\.)?Rng\\.NextFloat\\((-?[\\d.]+)f?,\\s*(-?[\\d.]+)f?\\)', 'g'))) {
      const name = rm[1] || rm[2];
      const base = vars[name];
      if (typeof base === 'number') {
        const low = parseFloat(rm[3]), high = parseFloat(rm[4]);
        vars[name] = `${Math.trunc(base + low)}-${Math.trunc(base + high)}`;
      }
    }
    // -= (decimal)Rng.NextInt(min, max)
    for (const rm of body.matchAll(new RegExp(dvFrag + '\\.BaseValue\\s*-=\\s*\\(decimal\\)\\s*(?:base\\.)?Rng\\.NextInt\\((-?\\d+),\\s*(-?\\d+)\\)', 'g'))) {
      const name = rm[1] || rm[2];
      const base = vars[name];
      if (typeof base === 'number') {
        const low = parseInt(rm[3], 10), high = parseInt(rm[4], 10) - 1;
        vars[name] = `${base - high}-${base - low}`;
      }
    }
    // = … MaxHp * 0.33m  → "33% Max"
    for (const rm of body.matchAll(/DynamicVars\.(\w+)\.BaseValue\s*=.*?MaxHp\s*\*\s*(\d+(?:\.\d+)?)m/g)) {
      vars[rm[1]] = `${Math.trunc(parseFloat(rm[2]) * 100)}% Max`;
    }
    // Heal to full: MaxHp - CurrentHp
    if (/Heal\.BaseValue\s*=.*MaxHp\s*-.*CurrentHp/.test(body)) vars.Heal = 'Full';
  }

  if (content.includes('HealRestSiteOption.GetHealAmount')) {
    if (!('Heal' in vars) || vars.Heal === 0) vars.Heal = '30% Max';
  }

  // Slippery Bridge: CurrentX => N + Y
  for (const rm of content.matchAll(/Current(\w+)\s*=>\s*(\d+)\s*\+\s*(\w+)/g)) {
    const name = rm[1], baseVal = parseInt(rm[2], 10);
    if (!(name in vars) || vars[name] === 0) vars[name] = `${baseVal}+`;
  }

  if (vars.EntrantNumber === -1) vars.EntrantNumber = '???';

  // StringVar with relic DynamicDescription
  for (const m of content.matchAll(/new\s+StringVar\("(\w+)",\s*ModelDb\.Relic<([^>]+)>\(\)\.DynamicDescription\.GetFormattedText\(\)\)/g)) {
    const varName = m[1];
    let className = m[2];
    if (className.includes('.')) className = className.split('.').pop();
    const entityId = classNameToId(className);
    const desc = relicDescs[entityId];
    if (desc) vars[varName] = desc;
  }

  // StringVar with model titles
  for (const m of content.matchAll(/new\s+StringVar\("(\w+)",\s*ModelDb\.(?:Card|Enchantment|Relic|Potion)<([^>]+)>\(\)\.Title(?:\.GetFormattedText\(\))?\)/g)) {
    const varName = m[1];
    let className = m[2];
    if (className.includes('.')) className = className.split('.').pop();
    const entityId = classNameToId(className);
    vars[varName] = titleMap[entityId] || className;
  }

  // StringVar literal: new StringVar("Name", "Value")
  for (const m of content.matchAll(/new\s+StringVar\("(\w+)",\s*"([^"]+)"\)/g)) {
    vars[m[1]] = m[2];
  }

  // Empty StringVar — runtime-populated, generate descriptive placeholder
  for (const m of content.matchAll(/new\s+StringVar\("(\w+)"\)/g)) {
    const name = m[1];
    if (name in vars) continue;
    const nl = name.toLowerCase();
    if (nl.includes('relic')) {
      vars[name] = nl.includes('owned') ? 'one of your Relics' : 'a random Relic';
    } else if (nl.includes('card'))   vars[name] = 'a random Card';
    else if (nl.includes('potion'))   vars[name] = 'a random Potion';
    else {
      let readable = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+/g, '').trim();
      vars[name] = readable;
    }
  }

  // LocString.Add("Name", …) — runtime-populated
  for (const m of content.matchAll(/\.Add\(\s*"(\w+)"\s*,/g)) {
    const name = m[1];
    if (name in vars) continue;
    const nl = name.toLowerCase();
    if (nl === 'potion')         vars[name] = 'a Potion';
    else if (nl.includes('relic'))  vars[name] = 'a random Relic';
    else if (nl.includes('card'))   vars[name] = 'a random Card';
    else if (nl.includes('potion')) vars[name] = 'a random Potion';
    else if (nl === 'rarity')    vars[name] = 'Common';
    else if (nl === 'type')      vars[name] = 'Skill';
  }

  // RelicOption<X> — surface relic display names for option templates
  for (const m of content.matchAll(/RelicOption<(\w+)>/g)) {
    const relicClass = m[1];
    const entityId = classNameToId(relicClass);
    const title = titleMap[entityId];
    if (title) vars[relicClass] = title;
  }

  // Standard fallback extraction
  const standard = extractVarsFromSource(content);
  for (const [k, v] of Object.entries(standard)) {
    if (!(k in vars)) vars[k] = v;
  }
  return vars;
}

function loadRelicDescriptions(extractedDataDir) {
  const file = path.join(extractedDataDir, 'relics.json');
  if (!fs.existsSync(file)) return {};
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const r of arr) if (r && r.id) out[r.id] = r.description;
    return out;
  } catch (_) { return {}; }
}

// ── Option order from C# source ─────────────────────────────────────────────

function extractOptionOrder(content, eventId) {
  const order = {};
  const seen = {};
  const re = new RegExp(escapeRe(eventId) + '\\.pages\\.(\\w+)\\.options\\.(\\w+)', 'g');
  for (const m of content.matchAll(re)) {
    const page = m[1], opt = m[2];
    if (!order[page]) { order[page] = []; seen[page] = new Set(); }
    if (!seen[page].has(opt)) { seen[page].add(opt); order[page].push(opt); }
  }
  return order;
}

// ── Page / option extraction ────────────────────────────────────────────────

function parsePageOptions(eventId, pageName, localization, vars, relicDescs, sourceOrder) {
  const prefix = `${eventId}.pages.${pageName}.options.`;
  const optKeys = new Set();
  for (const key of Object.keys(localization)) {
    if (key.startsWith(prefix)) {
      optKeys.add(key.slice(prefix.length).split('.')[0]);
    }
  }

  let ordered;
  if (sourceOrder && sourceOrder[pageName]) {
    ordered = sourceOrder[pageName].filter(o => optKeys.has(o));
    const rem = [...optKeys].filter(o => !ordered.includes(o)).sort();
    ordered = ordered.concat(rem);
  } else {
    ordered = [...optKeys].sort();
  }

  const out = [];
  for (const optName of ordered) {
    const titleRaw = localization[`${prefix}${optName}.title`] || optName;
    const title = stripRichTags(resolveDescription(titleRaw, vars, false));
    const descRaw = localization[`${prefix}${optName}.description`] || '';
    const descRes = descRaw ? resolveDescription(descRaw, vars, false) : '';
    let description = stripRichTags(descRes);
    if (!description) {
      const rd = relicDescs[optName];
      if (rd) description = `Obtain [gold]${title}[/gold]. ${rd}`;
    }
    out.push({ id: optName, title, description });
  }
  return out;
}

function parseAllPages(eventId, localization, vars, relicDescs, sourceOrder) {
  const pagePrefix = `${eventId}.pages.`;
  const pageNames = new Set();
  for (const key of Object.keys(localization)) {
    if (key.startsWith(pagePrefix)) pageNames.add(key.slice(pagePrefix.length).split('.')[0]);
  }
  if (pageNames.size <= 1) return null;

  const pages = [];
  for (const pageName of [...pageNames].sort()) {
    const descRaw = localization[`${pagePrefix}${pageName}.description`] || '';
    const descRes = descRaw ? resolveDescription(descRaw, vars, false) : '';
    const description = stripRichTags(descRes);
    const options = parsePageOptions(eventId, pageName, localization, vars, relicDescs, sourceOrder);
    const page = { id: pageName, description: description || null };
    if (options && options.length) page.options = options;
    pages.push(page);
  }
  return pages.length > 1 ? pages : null;
}

// ── Ancient detection / dialogue / relics ───────────────────────────────────

function isAncientEvent(content) {
  return content.includes('AncientEventModel') || content.includes('LocTable => "ancients"');
}

const CHARACTERS = ['IRONCLAD', 'SILENT', 'DEFECT', 'NECROBINDER', 'REGENT'];

function parseAncientDialogue(eventId, localization) {
  const dialogue = {};
  const prefix = `${eventId}.talk.`;
  for (const [key, value] of Object.entries(localization)) {
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split('.');
    if (parts.length < 3) continue;
    const speakerGroup = parts[0];
    const visitLine    = parts[1];
    const lineType     = parts[2];
    if (lineType === 'next') continue;
    let groupKey;
    if      (speakerGroup === 'firstVisitEver') groupKey = 'First Visit';
    else if (speakerGroup === 'ANY')            groupKey = 'Returning';
    else groupKey = speakerGroup.replace(/_/g, ' ').toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
    if (!dialogue[groupKey]) dialogue[groupKey] = [];
    const speaker = lineType === 'ancient' ? 'ancient' : 'character';
    dialogue[groupKey].push({ order: visitLine, speaker, text: stripRichTags(value) });
  }
  for (const g of Object.keys(dialogue)) {
    dialogue[g].sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  }
  return dialogue;
}

function extractAncientRelics(content) {
  const ids = [];
  const seen = new Set();
  for (const m of content.matchAll(/(?:RelicOption|ModelDb\.Relic)<(\w+)>/g)) {
    const id = classNameToId(m[1]);
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

// ── Preconditions (IsAllowed body parsing) ──────────────────────────────────

function extractPreconditions(content, vars) {
  const sigM = content.match(/override\s+bool\s+IsAllowed\s*\(\s*I?RunState\s+\w+\s*\)/);
  if (!sigM) return null;
  const startBrace = content.indexOf('{', sigM.index + sigM[0].length);
  if (startBrace === -1) return null;
  const endIdx = findBlockEnd(content, startBrace);
  if (endIdx === -1) return null;
  const body = content.slice(startBrace + 1, endIdx - 1);

  if (/^\s*return\s+true\s*;\s*$/.test(body)) return null;

  const conditions = [];

  // Negated bodies: `if (cond) return false;` → cond's negation must hold
  let negatedBody = '';
  for (const nm of body.matchAll(/if\s*\(([^{]+?)\)\s*(?:\{[^}]*return\s+false\s*;[^}]*\}|return\s+false\s*;)/gs)) {
    negatedBody += nm[1] + '\n';
  }
  const positiveBody = body;

  // Gold (literal)
  const goldSeen = new Set();
  for (const gm of positiveBody.matchAll(/(?:\(decimal\)\s*)?p(?:layer)?\.Gold\s*>=\s*(\d+)/g)) {
    if (!goldSeen.has(gm[1])) { goldSeen.add(gm[1]); conditions.push(`Requires ${gm[1]}+ gold`); }
  }
  // Gold (DynamicVars ref)
  for (const gm of positiveBody.matchAll(/(?:\(decimal\)\s*)?p(?:layer)?\.Gold\s*>=\s*(?:base\.)?DynamicVars(?:\["(\w+)"\]|\.(\w+))\.(?:BaseValue|IntValue)/g)) {
    const name = gm[1] || gm[2];
    if (goldSeen.has(name)) continue;
    goldSeen.add(name);
    const val = vars[name];
    if (val != null) {
      const valStr = String(val);
      if (valStr.includes('-') && !valStr.startsWith('-')) {
        conditions.push(`Requires ${valStr} gold`);
      } else {
        conditions.push(`Requires ${val}+ gold`);
      }
    } else {
      conditions.push(`Requires enough gold (${name})`);
    }
  }

  // HP (literal) and HP percentage
  for (const hm of positiveBody.matchAll(/p\.Creature\.CurrentHp\s*>=\s*(\d+)/g)) {
    conditions.push(`Requires ${hm[1]}+ HP`);
  }
  for (const hm of positiveBody.matchAll(/p\.Creature\.CurrentHp\s*<=.*?MaxHp\s*\*\s*([\d.]+)m?/g)) {
    conditions.push(`Requires ≤${Math.trunc(parseFloat(hm[1]) * 100)}% HP`);
  }

  // Acts (negated → "Act N+", positive → "Act N only" / "Act 1–N only")
  for (const am of negatedBody.matchAll(/CurrentActIndex\s*==\s*(\d+)/g)) {
    conditions.push(`Act ${parseInt(am[1], 10) + 2}+`);
  }
  for (const am of negatedBody.matchAll(/CurrentActIndex\s*<\s*(\d+)/g)) {
    conditions.push(`Act ${parseInt(am[1], 10) + 1}+`);
  }
  for (const am of positiveBody.matchAll(/CurrentActIndex\s*==\s*(\d+)/g)) {
    if (!negatedBody.includes(`CurrentActIndex == ${am[1]}`)) {
      conditions.push(`Act ${parseInt(am[1], 10) + 1} only`);
    }
  }
  for (const am of positiveBody.matchAll(/CurrentActIndex\s*>\s*(\d+)/g)) {
    conditions.push(`Act ${parseInt(am[1], 10) + 2}+`);
  }
  for (const am of positiveBody.matchAll(/CurrentActIndex\s*<\s*(\d+)/g)) {
    if (!negatedBody.includes(`CurrentActIndex < ${am[1]}`)) {
      conditions.push(`Act 1–${am[1]} only`);
    }
  }

  // Floors
  for (const fm of body.matchAll(/TotalFloor\s*>\s*(\d+)/g)) {
    conditions.push(`Floor ${parseInt(fm[1], 10) + 1}+`);
  }

  // Deck conditions
  const strikeM = body.match(/CardTag\.Strike.*>=\s*(\d+)/);
  if (strikeM) conditions.push(`Requires ${strikeM[1]}+ Strikes in deck`);
  const defendM = body.match(/CardTag\.Defend.*>=\s*(\d+)/);
  if (defendM) conditions.push(`Requires ${defendM[1]}+ Defends in deck`);
  if (/Rarity\s*==\s*CardRarity\.Basic.*?IsRemovable/s.test(body)) {
    conditions.push('Requires a removable basic card');
  } else if (/IsRemovable/.test(body) && !/CardTag/.test(body)) {
    conditions.push('Requires removable cards in deck');
  }

  // Relics
  for (const rm of body.matchAll(/GetValidRelics.*?Count\(\)\s*>=\s*(\d+)/g)) {
    conditions.push(`Requires ${rm[1]}+ tradeable relics`);
  }
  if (body.includes('HasEventPet')) conditions.push('Cannot have an event pet');

  // Potions
  if (/player\.Potions\.Any\(\)/.test(body) || /p\.Potions\.Any\(\)/.test(body)) {
    conditions.push('Requires at least one potion');
  }
  if (body.includes('HasOpenPotionSlots')) conditions.push('Requires an empty potion slot');

  // Player count
  if (/Players\.Count\s*>\s*1[\s\S]*?return\s+false/.test(body)) conditions.push('Single player only');

  // Character unlock state
  if (/UnlockState\.CharacterCardPools\.Count\(\)\s*>\s*1/.test(body)) {
    conditions.push('Requires more than one character unlocked');
  }

  // FoulPotion
  if (body.includes('FoulPotion')) {
    conditions.push('Requires 100+ gold or a Foul Potion');
    return conditions.filter(c => c !== 'Requires 100+ gold');
  }

  return conditions.length ? conditions : null;
}

// ── Per-event ───────────────────────────────────────────────────────────────

function parseSingleEvent(filepath, localization, actMapping, titleMap, relicDescs, ancientImagesDir, monsterImagesDir, eventImagesDir) {
  const className = path.basename(filepath, '.cs');
  if (className.startsWith('Deprecated')) return null;

  const content = fs.readFileSync(filepath, 'utf8');
  const eventId = classNameToId(className);
  const isAncient = isAncientEvent(content);

  const title = localization[`${eventId}.title`] || className;
  const descRaw = localization[`${eventId}.pages.INITIAL.description`] || '';
  const vars = extractEventVars(content, titleMap, relicDescs);
  const desc = stripRichTags(descRaw ? resolveDescription(descRaw, vars, false) : '');

  const sourceOrder = extractOptionOrder(content, eventId);

  const options = isAncient
    ? []
    : parsePageOptions(eventId, 'INITIAL', localization, vars, relicDescs, sourceOrder);

  let act = actMapping[className];
  let eventType = isAncient ? 'Ancient' : 'Event';
  if (!act && !isAncient) eventType = 'Shared';

  const pages = parseAllPages(eventId, localization, vars, relicDescs, sourceOrder);
  const preconditions = extractPreconditions(content, vars);

  const result = {
    id: eventId,
    name: title,
    type: eventType,
    act: act || null,
    description: desc || null,
    preconditions,
    options: options.length ? options : null,
    pages,
  };

  // Non-Ancient events have splash art at `<eventImagesDir>/<id>.png`.
  // Ancient events go through the dedicated lookup further down.
  if (!isAncient && eventImagesDir) {
    const imgFile = imageNameIfExists(eventImagesDir, eventId.toLowerCase());
    if (imgFile) result.image_file = imgFile;
  }

  if (isAncient) {
    const epithet = localization[`${eventId}.epithet`];
    if (epithet) result.epithet = epithet;

    const dialogue = parseAncientDialogue(eventId, localization);
    if (Object.keys(dialogue).length) result.dialogue = dialogue;

    const imgBase = eventId.toLowerCase();
    // Ancients ship as `<name>.png`, `<name>_placeholder.png` (most current
    // ones), or — for redesigned-into-existing-monsters Ancients — fall back
    // to the monster sprite ("the_architect" → "architect").
    let imageFile =
      imageNameIfExists(ancientImagesDir, imgBase) ||
      imageNameIfExists(ancientImagesDir, `${imgBase}_placeholder`);
    if (!imageFile && monsterImagesDir) {
      const monsterName = imgBase.replace(/^the_/, '');
      imageFile = imageNameIfExists(monsterImagesDir, monsterName);
      if (imageFile) result._image_source = 'monsters';
    }
    if (imageFile) result.image_file = imageFile;

    const relics = extractAncientRelics(content);
    if (relics.length) result.relics = relics;

    if (!result.description) {
      const firstVisit = localization[`${eventId}.talk.firstVisitEver.0-0.ancient`];
      if (firstVisit) result.description = stripRichTags(firstVisit);
      else {
        for (const ch of CHARACTERS) {
          const line =
            localization[`${eventId}.talk.${ch}.0-0.ancient`] ||
            localization[`${eventId}.talk.${ch}.0-0r.ancient`] ||
            localization[`${eventId}.talk.${ch}.0-0.char`];
          if (line) { result.description = stripRichTags(line); break; }
        }
      }
    }
  }

  return result;
}

// ── Per-event "fix" passes (runtime values that static analysis misses) ────

function fixBattlewornDummy(event, localization) {
  if (event.id !== 'BATTLEWORN_DUMMY') return event;
  const hpVars = { Setting1Hp: 75, Setting2Hp: 150, Setting3Hp: 300 };
  const resolveOpt = (pageId, optId) => {
    const tpl = localization[`BATTLEWORN_DUMMY.pages.${pageId}.options.${optId}.description`];
    if (!tpl) return null;
    return stripRichTags(resolveDescription(tpl, hpVars, false));
  };
  for (const opt of (event.options || [])) {
    const d = resolveOpt('INITIAL', opt.id); if (d) opt.description = d;
  }
  for (const page of (event.pages || [])) {
    for (const opt of (page.options || [])) {
      const d = resolveOpt(page.id || '', opt.id); if (d) opt.description = d;
    }
  }
  return event;
}

function fixSpiralingWhirlpool(event) {
  if (event.id !== 'SPIRALING_WHIRLPOOL') return event;
  const valid = new Set(['OBSERVE', 'DRINK']);
  if (event.options) event.options = event.options.filter(o => valid.has(o.id));
  for (const p of (event.pages || [])) {
    if (p.options) p.options = p.options.filter(o => valid.has(o.id));
  }
  if (event.pages) {
    event.pages = event.pages.filter(p => p.id !== 'REACH_IN');
    if (event.pages.length <= 1) event.pages = null;
  }
  return event;
}

function fixColorfulPhilosophers(event) {
  if (event.id !== 'COLORFUL_PHILOSOPHERS') return event;
  if (event.options) event.options = event.options.filter(o => o.id !== 'EQUALITY');
  for (const p of (event.pages || [])) {
    if (p.options) p.options = p.options.filter(o => o.id !== 'EQUALITY');
  }
  return event;
}

function fixSlipperyBridge(event, localization) {
  if (event.id !== 'SLIPPERY_BRIDGE') return event;
  const PAGE_DAMAGE = {
    INITIAL: 3, HOLD_ON_0: 4, HOLD_ON_1: 5, HOLD_ON_2: 6, HOLD_ON_3: 7,
    HOLD_ON_4: 8, HOLD_ON_5: 9, HOLD_ON_6: 10, HOLD_ON_LOOP: 11,
  };
  const resolveHoldOn = (pageId, optId) => {
    const key = `SLIPPERY_BRIDGE.pages.${pageId}.options.${optId}.description`;
    const tpl = localization[key];
    if (!tpl) return null;
    const dmg = PAGE_DAMAGE[pageId] ?? 11;
    const suffix = dmg >= 11 ? '+' : '';
    return stripRichTags(resolveDescription(tpl, { HpLoss: `${dmg}${suffix}` }, false));
  };
  for (const opt of (event.options || [])) {
    if (opt.id.startsWith('HOLD_ON')) { const d = resolveHoldOn('INITIAL', opt.id); if (d) opt.description = d; }
  }
  for (const page of (event.pages || [])) {
    for (const opt of (page.options || [])) {
      if (opt.id.startsWith('HOLD_ON')) {
        const d = resolveHoldOn(page.id || '', opt.id);
        if (d) opt.description = d;
      }
    }
  }
  return event;
}

function fixAbyssalBaths(event, localization) {
  if (event.id !== 'ABYSSAL_BATHS') return event;
  const lingerTemplate = localization['ABYSSAL_BATHS.pages.ALL.options.LINGER.description'] || '';
  const lingerTitle    = localization['ABYSSAL_BATHS.pages.ALL.options.LINGER.title'] || 'Linger';
  const exitTitle      = localization['ABYSSAL_BATHS.pages.ALL.options.EXIT_BATHS.title'] || 'Exit Baths';
  const exitDesc       = localization['ABYSSAL_BATHS.pages.ALL.options.EXIT_BATHS.description'] || '';
  const deathDesc      = localization['ABYSSAL_BATHS.pages.DEATH_WARNING.description'] || '';

  const resolveLinger = (damage) => resolveDescription(lingerTemplate, { MaxHp: 2, Damage: damage }, false);

  for (const page of (event.pages || [])) {
    const id = page.id || '';
    if (/^LINGER\d+$/.test(id)) {
      const step = parseInt(id.slice('LINGER'.length), 10);
      const dmg  = 3 + step + 1;
      page.options = [
        { id: 'LINGER',     title: lingerTitle, description: resolveLinger(dmg) },
        { id: 'EXIT_BATHS', title: exitTitle,   description: exitDesc },
      ];
    } else if (id === 'DEATH_WARNING') {
      page.options = [
        { id: 'LINGER',     title: lingerTitle, description: deathDesc },
        { id: 'EXIT_BATHS', title: exitTitle,   description: exitDesc },
      ];
    } else if (id === 'IMMERSE') {
      page.options = [
        { id: 'LINGER',     title: lingerTitle, description: resolveLinger(4) },
        { id: 'EXIT_BATHS', title: exitTitle,   description: exitDesc },
      ];
    }
  }
  return event;
}

function fixTabletOfTruth(event) {
  if (event.id !== 'TABLET_OF_TRUTH') return event;
  const PAGE_COSTS = { DECIPHER_1: '6', DECIPHER_2: '12', DECIPHER_3: '24' };
  for (const page of (event.pages || [])) {
    const id = page.id || '';
    for (const opt of (page.options || [])) {
      if (opt.id !== 'DECIPHER') continue;
      if (PAGE_COSTS[id]) {
        opt.description = (opt.description || '').replace(/Lose \[red\]\d+\[\/red\]/, `Lose [red]${PAGE_COSTS[id]}[/red]`);
      } else if (id === 'DECIPHER_4') {
        opt.description = 'Set Max HP to [red]1[/red]. [gold]Upgrade ALL[/gold] cards.';
      }
    }
  }
  return event;
}

function fixOptionOrder(event, correctOrder) {
  const reorder = (options) => {
    const byId = Object.fromEntries(options.map(o => [o.id, o]));
    const ordered = correctOrder.filter(oid => oid in byId).map(oid => byId[oid]);
    return ordered.concat(options.filter(o => !correctOrder.includes(o.id)));
  };
  if (event.options) event.options = reorder(event.options);
  for (const p of (event.pages || [])) {
    if (p.id === 'INITIAL' && p.options) p.options = reorder(p.options);
  }
  return event;
}

const PER_EVENT_FIX_ORDER = [
  ['AMALGAMATOR',     ['COMBINE_STRIKES', 'COMBINE_DEFENDS']],
  ['WOOD_CARVINGS',   ['BIRD', 'SNAKE', 'SNAKE_LOCKED', 'TORUS']],
  ['RANWID_THE_ELDER',['POTION', 'POTION_LOCKED', 'GOLD', 'RELIC', 'RELIC_LOCKED']],
];

function fixLostWisp(event) {
  if (event.id !== 'LOST_WISP') return event;
  if (event.options) event.options = event.options.filter(o => o.id !== 'CLAIM_LOCKED');
  for (const p of (event.pages || [])) {
    if (p.options) p.options = p.options.filter(o => o.id !== 'CLAIM_LOCKED');
  }
  return event;
}

function fixFakeMerchant(event) {
  if (event.id !== 'FAKE_MERCHANT') return event;
  event.description =
    'A suspicious merchant offers 9 fake relics at 42–58 gold each. ' +
    'Throwing a [gold]Foul Potion[/gold] starts a fight against The Merchant??? (165 HP). ' +
    'Winning rewards [gold]Fake Merchant\'s Rug[/gold] plus all unsold relics.';
  return event;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   decompiledRoot       — path to the ILSpy decompile root
 *   locDir               — path to <raw>/localization/<lang>
 *   ancientImagesDir     — extracted ancients image dir
 *   monsterImagesDir     — extracted monster sprite dir (fallback)
 *   relicDataPath        — path to already-parsed relics.json (for cross-refs)
 */
function parseAllEvents({ decompiledRoot, locDir, imagesDir, ancientImagesDir, monsterImagesDir, relicDataPath }) {
  // `imagesDir` (when present) holds the non-Ancient event splash art.
  // `ancientImagesDir` and `monsterImagesDir` are looked up only for Ancient
  // events (they ship under separate folders in the GDRE PCK extraction).
  const eventImagesDir = imagesDir || null;
  const eventsDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Events');
  const actsDir   = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Acts');
  if (!eventsDir) {
    console.warn(`Events namespace not found under ${decompiledRoot}`);
    return [];
  }

  const localization = loadLocalization(locDir);
  const actMapping   = buildActMapping(actsDir);
  const titleMap     = loadAllTitles(locDir);
  const relicDescs   = relicDataPath ? loadRelicDescriptions(path.dirname(relicDataPath)) : {};

  const events = [];
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.cs')).sort();
  for (const f of files) {
    const ev = parseSingleEvent(
      path.join(eventsDir, f),
      localization,
      actMapping,
      titleMap,
      relicDescs,
      ancientImagesDir,
      monsterImagesDir,
      eventImagesDir,
    );
    if (!ev) continue;
    let e = ev;
    e = fixTabletOfTruth(e);
    e = fixAbyssalBaths(e, localization);
    e = fixBattlewornDummy(e, localization);
    e = fixSpiralingWhirlpool(e);
    e = fixColorfulPhilosophers(e);
    e = fixSlipperyBridge(e, localization);
    for (const [evId, order] of PER_EVENT_FIX_ORDER) {
      if (e.id === evId) e = fixOptionOrder(e, order);
    }
    e = fixLostWisp(e);
    e = fixFakeMerchant(e);
    events.push(e);
  }
  return events;
}

module.exports = { parseAllEvents, parseSingleEvent, classNameToId };
