'use strict';
/**
 * card_parser.js — JS port of
 *   spire-codex/backend/app/parsers/card_parser.py
 *
 * Reads:
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Cards/*.cs
 *   <decompiled>/MegaCrit.Sts2.Core.Models.CardPools/*.cs
 *   <raw>/localization/<lang>/cards.json
 *   <raw>/localization/<lang>/card_keywords.json
 *   <raw>/localization/<lang>/powers.json
 *   <raw>/localization/<lang>/events.json
 *   <raw>/localization/<lang>/gameplay_ui.json
 *
 * Emits one record per card with cost/type/rarity/target, damage/block/keywords,
 * upgrade deltas, type variants (Mad Science), and image references.
 */

const fs   = require('fs');
const path = require('path');
const { resolveDescription, extractVarsFromSource } = require('./description_resolver.js');
const { resolveNamespaceDir } = require('./source_layout.js');

// ── Enum maps (numeric → name and name → name passthrough) ──────────────────

const CARD_TYPE_MAP = {
  0: 'None', 1: 'Attack', 2: 'Skill', 3: 'Power', 4: 'Status', 5: 'Curse', 6: 'Quest',
};
const CARD_RARITY_MAP = {
  0: 'None', 1: 'Basic', 2: 'Common', 3: 'Uncommon', 4: 'Rare',
  5: 'Ancient', 6: 'Event', 7: 'Token', 8: 'Status', 9: 'Curse', 10: 'Quest',
};
const TARGET_TYPE_MAP = {
  0: 'None', 1: 'Self', 2: 'AnyEnemy', 3: 'AllEnemies', 4: 'RandomEnemy',
  5: 'AnyPlayer', 6: 'AnyAlly', 7: 'AllAllies', 8: 'TargetedNoCreature', 9: 'Osty',
};

const POOL_ORDER = [
  'ironclad', 'silent', 'regent', 'necrobinder', 'defect',
  'colorless', 'curse', 'deprecated', 'event', 'quest', 'status', 'token',
];
const POOL_INDEX = Object.fromEntries(POOL_ORDER.map((p, i) => [p, i]));

const RARITY_ORDER = [
  'Basic', 'Common', 'Uncommon', 'Rare', 'Ancient',
  'Event', 'Token', 'Status', 'Curse', 'Quest', 'None',
];
const RARITY_INDEX = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, i]));

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

function imageNameIfExists(dir, base) {
  if (!dir) return null;
  for (const ext of ['webp', 'png']) {
    const fp = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(fp)) return `${base}.${ext}`;
  }
  return null;
}

// Many card flags are written either as compact expression-bodied properties
// (`IsEthereal => true;` — ILSpy default) or as expanded getter blocks
// (`IsEthereal { get { return true; } }` — dnSpy default). This helper
// matches either form so the parser doesn't depend on which decompiler ran.
function hasOverride(content, propName, valueRe = 'true') {
  const compact  = new RegExp(`\\b${propName}\\s*=>\\s*${valueRe}\\b`);
  if (compact.test(content)) return true;
  const expanded = new RegExp(`\\b${propName}\\b[\\s\\S]{0,200}?return\\s+${valueRe}\\b`);
  return expanded.test(content);
}

// ── Pools ───────────────────────────────────────────────────────────────────

function parseCardPools(poolsDir) {
  const POOL_FILES = {
    'IroncladCardPool.cs':    'ironclad',
    'SilentCardPool.cs':      'silent',
    'DefectCardPool.cs':      'defect',
    'NecrobinderCardPool.cs': 'necrobinder',
    'RegentCardPool.cs':      'regent',
    'ColorlessCardPool.cs':   'colorless',
    'CurseCardPool.cs':       'curse',
    'StatusCardPool.cs':      'status',
    'EventCardPool.cs':       'event',
    'TokenCardPool.cs':       'token',
    'QuestCardPool.cs':       'quest',
  };
  const map = {};
  for (const [filename, color] of Object.entries(POOL_FILES)) {
    const fp = path.join(poolsDir, filename);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    for (const m of content.matchAll(/ModelDb\.Card<(\w+)>\(\)/g)) {
      map[m[1]] = color;
    }
  }
  return map;
}

// ── Per-card ────────────────────────────────────────────────────────────────

function parseSingleCard(filepath, localization, cardPools, eventLoc, allCardFiles, imagesDir) {
  const className = path.basename(filepath, '.cs');
  const content   = fs.readFileSync(filepath, 'utf8');

  // Constructor: : base(cost, CardType.X, CardRarity.Y, TargetType.Z)
  let cost, cardType, rarity, target;
  let baseM = content.match(/:\s*base\(\s*(-?\d+)\s*,\s*CardType\.(\w+)\s*,\s*CardRarity\.(\w+)\s*,\s*TargetType\.(\w+)/);
  if (baseM) {
    cost     = parseInt(baseM[1], 10);
    cardType = baseM[2];
    rarity   = baseM[3];
    target   = baseM[4];
  } else {
    // Some cards use numeric enum values
    baseM = content.match(/:\s*base\(\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!baseM) return null;
    cost     = parseInt(baseM[1], 10);
    cardType = CARD_TYPE_MAP[parseInt(baseM[2], 10)]   || 'Unknown';
    rarity   = CARD_RARITY_MAP[parseInt(baseM[3], 10)] || 'Unknown';
    target   = TARGET_TYPE_MAP[parseInt(baseM[4], 10)] || 'Unknown';
  }

  const cardId = classNameToId(className);

  let allVars = extractVarsFromSource(content);

  // PowerVar<XxxPower>(Nm) — list of powers this card applies
  const powersApplied = [];
  for (const pm of content.matchAll(/new PowerVar<(\w+)>\((\d+)m\)/g)) {
    powersApplied.push({ power: pm[1].replace(/Power$/, ''), amount: parseInt(pm[2], 10) });
  }

  // Damage / block — with fallbacks for OstyDamage and CalculatedDamage
  let damage = allVars.Damage;
  let block  = allVars.Block;
  if (damage == null && allVars.OstyDamage != null) {
    damage = allVars.OstyDamage;
    allVars.Damage = damage;
  }
  if (damage == null && allVars.CalculationBase != null) damage = allVars.CalculationBase;
  else if (damage == null && allVars.CalculatedDamage != null) damage = allVars.CalculatedDamage;

  // Star cost — same dnSpy/ILSpy duality as CanonicalKeywords below. Most
  // cards use the dnSpy block form; keep the lambda regex as a fallback.
  //   dnSpy: `CanonicalStarCost { get { return 3; } }`
  //   ILSpy: `CanonicalStarCost => 3`
  const starCostM = content.match(/CanonicalStarCost\s*\{\s*get\s*\{[\s\S]*?return\s+(-?\d+)/) ||
                    content.match(/CanonicalStarCost\s*=>\s*(-?\d+)/);
  if (starCostM) allVars.StarCost = parseInt(starCostM[1], 10);

  const cardsDraw  = allVars.Cards;
  const energyGain = allVars.Energy;
  const hpLoss     = allVars.HpLoss;

  // Upgrades
  let upgradeDamage = null, upgradeBlock = null, costUpgrade = null;
  const dmgUp = content.match(/(?<!\w)Damage\.UpgradeValueBy\((\d+)m\)/);
  if (dmgUp) upgradeDamage = parseInt(dmgUp[1], 10);
  const blkUp = content.match(/(?<!\w)Block\.UpgradeValueBy\((\d+)m\)/);
  if (blkUp) upgradeBlock = parseInt(blkUp[1], 10);

  const costUp = content.match(/UpgradeEnergyCost\((\d+)\)/);
  if (costUp) costUpgrade = parseInt(costUp[1], 10);
  if (costUpgrade == null) {
    const costUp2 = content.match(/EnergyCost\.UpgradeBy\((-?\d+)\)/);
    if (costUp2) costUpgrade = cost + parseInt(costUp2[1], 10);
  }

  // Keywords from the `CanonicalKeywords` property. Two decompiler styles:
  //   ILSpy: `CanonicalKeywords => new[] { CardKeyword.Innate };`
  //   dnSpy: `CanonicalKeywords { get { return new …<CardKeyword>(new CardKeyword[] { CardKeyword.Innate }); } }`
  // A 500-char bounded scan after the property name is enough to cover the
  // largest keyword arrays in STS2 (typically ≤4 keywords) without leaking
  // into the next class member.
  const keywords = [];
  let canonicalKwBlock = '';
  const ckwIdx = content.search(/\bCanonicalKeywords\b/);
  if (ckwIdx !== -1) {
    canonicalKwBlock = content.slice(ckwIdx, Math.min(ckwIdx + 500, content.length));
  }
  for (const kw of ['Exhaust', 'Innate', 'Ethereal', 'Retain', 'Unplayable', 'Sly', 'Eternal']) {
    if (canonicalKwBlock.includes(`CardKeyword.${kw}`)) keywords.push(kw);
  }

  // Property-override keywords (compact `=>` and expanded `{ get { return … } }` both supported)
  if (!keywords.includes('Ethereal')   && hasOverride(content, 'IsEthereal',   'true'))  keywords.push('Ethereal');
  if (!keywords.includes('Innate')     && hasOverride(content, 'IsInnate',     'true'))  keywords.push('Innate');
  if (!keywords.includes('Exhaust')) {
    if (hasOverride(content, 'ExhaustOnPlay', 'true') || hasOverride(content, 'ShouldExhaust', 'true')) keywords.push('Exhaust');
    else if (/CardKeyword\.Exhaust/.test(content) && content.includes('AddKeyword'))                   keywords.push('Exhaust');
  }
  if (!keywords.includes('Retain') && (hasOverride(content, 'IsRetain', 'true') || hasOverride(content, 'IsRetainable', 'true'))) keywords.push('Retain');
  if (!keywords.includes('Unplayable') && hasOverride(content, 'IsUnplayable', 'true')) keywords.push('Unplayable');
  if (!keywords.includes('Sly')     && /CardKeyword\.Sly/.test(content)     && content.includes('AddKeyword')) keywords.push('Sly');
  if (!keywords.includes('Eternal') && /CardKeyword\.Eternal/.test(content) && content.includes('AddKeyword')) keywords.push('Eternal');

  // Tags
  const tags = [];
  for (const tag of ['Strike', 'Defend', 'Minion', 'OstyAttack', 'Shiv']) {
    if (new RegExp(`CardTag\\.${tag}`).test(content)) tags.push(tag);
  }

  // Related / spawned cards
  const related = new Set();
  for (const m of content.matchAll(/HoverTipFactory\.FromCard(?:WithCardHoverTips)?<(\w+)>/g)) related.add(m[1]);
  for (const m of content.matchAll(/CreateCard<(\w+)>/g)) related.add(m[1]);
  for (const m of content.matchAll(/(\w+)\.Create\(/g))   { if (allCardFiles.has(m[1])) related.add(m[1]); }
  for (const m of content.matchAll(/\.OfType<(\w+)>\(\)/g)) { if (allCardFiles.has(m[1])) related.add(m[1]); }
  related.delete(className);
  const spawnsCards = related.size ? [...related].map(classNameToId).sort() : null;

  const isXCost     = hasOverride(content, 'HasEnergyCostX', 'true') || hasOverride(content, 'CostsX', 'true');
  const isXStarCost = hasOverride(content, 'HasStarCostX',  'true');

  // Multi-hit
  let hitCount = null;
  const hitM = content.match(/WithHitCount\((\d+)\)/);
  if (hitM) hitCount = parseInt(hitM[1], 10);
  else if (/WithHitCount\(/.test(content) && allVars.Repeat) hitCount = allVars.Repeat;

  // Localization
  const title       = localization[`${cardId}.title`]       || className;
  const description = localization[`${cardId}.description`] || '';

  const color = cardPools[className] || 'unknown';

  const resolveVars = { ...allVars, CardType: cardType };
  const descRendered = resolveDescription(description, resolveVars, false);

  // Type variants for cards with {CardType:choose(…)} (e.g. Mad Science)
  let typeVariants = null;
  if (description.includes('{CardType:choose(')) {
    const RIDERS = {
      Attack: ['Sapping', 'Violence', 'Choking'],
      Skill:  ['Energized', 'Wisdom', 'Chaos'],
      Power:  ['Expertise', 'Curious', 'Improvement'],
    };
    typeVariants = {};
    for (const vtype of ['Attack', 'Skill', 'Power']) {
      const vVars = { ...allVars, CardType: vtype };
      const vDesc = resolveDescription(description, vVars, false);
      const vEntry = { type: vtype, description: vDesc };
      if (vtype === 'Attack' && damage != null) vEntry.damage = damage;
      else if (vtype === 'Skill' && block != null) vEntry.block = block;
      // Mad Science variants live alongside other portraits under the
      // card's color subfolder (e.g. card_portraits/event/mad_science_attack.png),
      // not at the imagesDir root. Mirror the main-image lookup logic.
      const variantBase = `${cardId.toLowerCase()}_${vtype.toLowerCase()}`;
      const colorSubdir = (color && color !== 'unknown') ? path.join(imagesDir, color) : imagesDir;
      const vImg = imageNameIfExists(colorSubdir, variantBase);
      if (vImg) {
        vEntry.image_file = colorSubdir === imagesDir ? vImg : `${color}/${vImg}`;
      }
      // Riders sub-variants
      const riders = [];
      for (const rider of (RIDERS[vtype] || [])) {
        const riderDescKey  = `TINKER_TIME.pages.CHOOSE_RIDER.options.${rider.toUpperCase()}.description`;
        const riderTitleKey = `TINKER_TIME.pages.CHOOSE_RIDER.options.${rider.toUpperCase()}.title`;
        const riderDescRaw  = eventLoc?.[riderDescKey]  || '';
        const riderTitle    = eventLoc?.[riderTitleKey] || rider;
        const riderDesc     = riderDescRaw ? resolveDescription(riderDescRaw, allVars, false) : '';
        riders.push({ id: rider.toUpperCase(), name: riderTitle, description: riderDesc });
      }
      if (riders.length) vEntry.riders = riders;
      typeVariants[vtype.toLowerCase()] = vEntry;
    }
  }

  const starCost = allVars.StarCost ?? null;

  // CanBeGeneratedInCombat — only emit when explicitly false
  let canBeGeneratedInCombat = null;
  if (hasOverride(content, 'CanBeGeneratedInCombat', 'false')) canBeGeneratedInCombat = false;

  // Image — GDRE extracts card portraits to `<imagesDir>/<color>/<id>.png`
  // (e.g. card_portraits/ironclad/bash.png). Some cards (under active
  // rework or art revision) only ship the beta version at
  // `<color>/beta/<id>.png`, so we fall back to that. Returned path is
  // relative to imagesDir so the renderer doesn't need to know which split.
  const baseLower = cardId.toLowerCase();
  let imageFile = null;
  if (imagesDir) {
    const candidates = [];
    if (color && color !== 'unknown') {
      candidates.push({ dir: path.join(imagesDir, color),         prefix: `${color}/` });
      candidates.push({ dir: path.join(imagesDir, color, 'beta'), prefix: `${color}/beta/` });
    }
    candidates.push({ dir: imagesDir, prefix: '' });
    for (const c of candidates) {
      const found = imageNameIfExists(c.dir, baseLower);
      if (found) { imageFile = c.prefix + found; break; }
    }
  }
  if (!imageFile && typeVariants && typeVariants[cardType.toLowerCase()]) {
    imageFile = typeVariants[cardType.toLowerCase()].image_file || null;
  }

  const card = {
    id: cardId,
    name: title,
    description: descRendered,
    description_raw: description,
    cost,
    is_x_cost:      isXCost ? true : null,
    is_x_star_cost: isXStarCost ? true : null,
    star_cost:      starCost,
    type:   cardType,
    rarity, target,
    color,
    damage: damage ?? null,
    block:  block  ?? null,
    hit_count: hitCount,
    powers_applied: powersApplied.length ? powersApplied : null,
    cards_draw:  cardsDraw  ?? null,
    energy_gain: energyGain ?? null,
    hp_loss:     hpLoss     ?? null,
    keywords: keywords.length ? keywords : null,
    tags:     tags.length     ? tags     : null,
    spawns_cards: spawnsCards,
    vars: Object.keys(allVars).length ? allVars : null,
    upgrade: {},
    image_file: imageFile,
    type_variants: typeVariants,
    can_be_generated_in_combat: canBeGeneratedInCombat,
    upgrade_description: null,
  };

  if (upgradeDamage)        card.upgrade.damage = `+${upgradeDamage}`;
  if (upgradeBlock)         card.upgrade.block  = `+${upgradeBlock}`;
  if (costUpgrade != null)  card.upgrade.cost   = costUpgrade;

  // Generic var upgrades (Property and dictionary forms)
  for (const pm of content.matchAll(/(\w+)\.UpgradeValueBy\((-?\d+)m\)/g)) {
    const v = pm[1], n = parseInt(pm[2], 10);
    if (v !== 'Damage' && v !== 'Block') card.upgrade[v.toLowerCase()] = (n >= 0 ? '+' : '') + n;
  }
  for (const pm of content.matchAll(/\["(\w+)"\]\.UpgradeValueBy\((-?\d+)m\)/g)) {
    const v = pm[1], n = parseInt(pm[2], 10);
    if (!(v.toLowerCase() in card.upgrade)) card.upgrade[v.toLowerCase()] = (n >= 0 ? '+' : '') + n;
  }

  // Keyword changes inside void OnUpgrade() {…}
  const upM = content.match(/void\s+OnUpgrade\(\)\s*\{/);
  if (upM) {
    let i = upM.index + upM[0].length, depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    const upgradeBody = content.slice(upM.index + upM[0].length, i - 1);
    for (const km of upgradeBody.matchAll(/AddKeyword\(CardKeyword\.(\w+)\)/g))    card.upgrade[`add_${km[1].toLowerCase()}`]    = true;
    for (const km of upgradeBody.matchAll(/RemoveKeyword\(CardKeyword\.(\w+)\)/g)) card.upgrade[`remove_${km[1].toLowerCase()}`] = true;
  }

  if (!Object.keys(card.upgrade).length) card.upgrade = null;

  // upgrade_description: bump numeric vars matching upgrade keys, then re-resolve.
  const upgradedVars = { ...resolveVars };
  if (card.upgrade) {
    for (const [key, val] of Object.entries(card.upgrade)) {
      if (typeof val !== 'string' || (val[0] !== '+' && val[0] !== '-')) continue;
      const diff = parseInt(val, 10);
      if (Number.isNaN(diff)) continue;
      const keyL = key.toLowerCase();
      for (const vk of Object.keys(upgradedVars)) {
        if (typeof upgradedVars[vk] !== 'number') continue;
        const vkL = vk.toLowerCase();
        if (vkL === keyL || vkL === keyL + 'power') upgradedVars[vk] += diff;
      }
    }
  }
  const upDesc = resolveDescription(description, upgradedVars, /* isUpgraded */ true);
  if (upDesc !== descRendered) card.upgrade_description = upDesc;

  // Text-only upgrade marker (only IfUpgraded sections, no numeric deltas)
  if (!card.upgrade && card.upgrade_description) card.upgrade = { description_changed: true };

  return card;
}

// ── Localization tables ─────────────────────────────────────────────────────

function buildTypeMap(g) {
  return {
    Attack: g['CARD_TYPE.ATTACK'] || 'Attack',
    Skill:  g['CARD_TYPE.SKILL']  || 'Skill',
    Power:  g['CARD_TYPE.POWER']  || 'Power',
    Status: g['CARD_TYPE.STATUS'] || 'Status',
    Curse:  g['CARD_TYPE.CURSE']  || 'Curse',
    Quest:  g['CARD_TYPE.QUEST']  || 'Quest',
  };
}
function buildRarityMap(g) {
  return {
    Basic:    g['CARD_RARITY.BASIC']    || 'Basic',
    Common:   g['CARD_RARITY.COMMON']   || 'Common',
    Uncommon: g['CARD_RARITY.UNCOMMON'] || 'Uncommon',
    Rare:     g['CARD_RARITY.RARE']     || 'Rare',
    Ancient:  g['CARD_RARITY.ANCIENT']  || 'Ancient',
    Event:    g['CARD_RARITY.EVENT']    || 'Event',
    Token:    g['CARD_RARITY.TOKEN']    || 'Token',
    Status:   g['CARD_RARITY.STATUS']   || 'Status',
    Curse:    g['CARD_RARITY.CURSE']    || 'Curse',
    Quest:    g['CARD_RARITY.QUEST']    || 'Quest',
  };
}

function loadKeywordNames(loc) {
  const map = {};
  const seen = new Set();
  for (const key of Object.keys(loc)) {
    const id = key.split('.')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = loc[`${id}.title`];
    if (title) { map[id] = title; map[id.toUpperCase()] = title; }
  }
  return map;
}

function loadPowerNames(loc) {
  const map = {};
  const seen = new Set();
  for (const key of Object.keys(loc)) {
    const id = key.split('.')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = loc[`${id}.title`];
    if (!title) continue;
    const base = id.replace(/_POWER$/, '');
    // "THORNS_POWER" → "Thorns" (PascalCase, spaces removed)
    const baseTitle = base.split('_')
      .map(w => w[0] + w.slice(1).toLowerCase())
      .join('');
    map[baseTitle] = title;
  }
  return map;
}

function localizeCard(card, typeMap, rarityMap, kwNames, powerNames) {
  card.type_key   = card.type;
  card.rarity_key = card.rarity;
  card.type   = typeMap[card.type]     || card.type;
  card.rarity = rarityMap[card.rarity] || card.rarity;
  if (card.keywords) {
    card.keywords_key = [...card.keywords];
    card.keywords     = card.keywords.map(kw => kwNames[kw.toUpperCase()] || kw);
  }
  if (card.powers_applied) {
    for (const pa of card.powers_applied) {
      pa.power_key = pa.power;
      pa.power     = powerNames[pa.power] || pa.power;
    }
  }
  return card;
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseAllCards({ decompiledRoot, locDir, imagesDir }) {
  const cardsDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Cards');
  const poolsDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.CardPools');
  if (!cardsDir) {
    console.warn(`Cards namespace not found under ${decompiledRoot}`);
    return [];
  }

  const localization = readJsonOrEmpty(path.join(locDir, 'cards.json'));
  const cardKwLoc    = readJsonOrEmpty(path.join(locDir, 'card_keywords.json'));
  const powersLoc    = readJsonOrEmpty(path.join(locDir, 'powers.json'));
  const eventLoc     = readJsonOrEmpty(path.join(locDir, 'events.json'));
  const gameplayUi   = readJsonOrEmpty(path.join(locDir, 'gameplay_ui.json'));

  const cardPools = parseCardPools(poolsDir);
  const typeMap   = buildTypeMap(gameplayUi);
  const rarityMap = buildRarityMap(gameplayUi);
  const kwNames    = loadKeywordNames(cardKwLoc);
  const powerNames = loadPowerNames(powersLoc);

  const allCardFiles = new Set(
    fs.readdirSync(cardsDir).filter(f => f.endsWith('.cs')).map(f => f.replace(/\.cs$/, ''))
  );

  const cards = [];
  for (const f of [...allCardFiles].sort()) {
    if (f.startsWith('Mock') || f === 'DeprecatedCard') continue;
    const c = parseSingleCard(path.join(cardsDir, f + '.cs'), localization, cardPools, eventLoc, allCardFiles, imagesDir);
    if (c) {
      localizeCard(c, typeMap, rarityMap, kwNames, powerNames);
      cards.push(c);
    }
  }

  cards.sort((a, b) => {
    return (POOL_INDEX[a.color] ?? 99) - (POOL_INDEX[b.color] ?? 99)
        || (RARITY_INDEX[a.rarity_key || a.rarity] ?? 99) - (RARITY_INDEX[b.rarity_key || b.rarity] ?? 99)
        || a.id.localeCompare(b.id);
  });
  cards.forEach((c, i) => { c.compendium_order = i; });
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

module.exports = { parseAllCards, parseSingleCard, classNameToId };
