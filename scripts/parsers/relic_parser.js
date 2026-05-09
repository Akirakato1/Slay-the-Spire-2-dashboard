'use strict';
/**
 * relic_parser.js — JS port of
 *   spire-codex/backend/app/parsers/relic_parser.py
 *
 * Reads:
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Relics/*.cs
 *   <decompiled>/MegaCrit.Sts2.Core.Models.RelicPools/*.cs
 *   <raw>/localization/<lang>/relics.json
 *   <raw>/localization/<lang>/enchantments.json   (for StringVar refs)
 *   <raw>/localization/<lang>/gameplay_ui.json
 *
 * Emits one record per relic with description, flavor, rarity, pool, merchant
 * price, image (incl. character variants), and name variants (Sea Glass).
 */

const fs   = require('fs');
const path = require('path');
const { resolveDescription, extractVarsFromSource } = require('./description_resolver.js');
const { resolveNamespaceDir } = require('./source_layout.js');

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

function camelToSpaced(name) {
  // "GoopyEnchantment" → "Goopy Enchantment"
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ── Pool / starter-upgrade discovery ────────────────────────────────────────

function parseStarterUpgrades(relicsDir) {
  const touchFile = path.join(relicsDir, 'TouchOfOrobas.cs');
  if (!fs.existsSync(touchFile)) return {};
  const content = fs.readFileSync(touchFile, 'utf8');
  const out = {};
  for (const m of content.matchAll(/ModelDb\.Relic<(\w+)>\(\)\.Id,\s*ModelDb\.Relic<(\w+)>\(\)/g)) {
    out[m[2]] = m[1];   // upgraded → base
  }
  return out;
}

function parseRelicPools(relicPoolsDir, relicsDir) {
  const POOL_FILES = {
    'IroncladRelicPool.cs':    'ironclad',
    'SilentRelicPool.cs':      'silent',
    'DefectRelicPool.cs':      'defect',
    'NecrobinderRelicPool.cs': 'necrobinder',
    'RegentRelicPool.cs':      'regent',
    'SharedRelicPool.cs':      'shared',
  };
  const map = {};
  for (const [filename, poolName] of Object.entries(POOL_FILES)) {
    const fp = path.join(relicPoolsDir, filename);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    for (const m of content.matchAll(/ModelDb\.Relic<(\w+)>\(\)/g)) {
      map[m[1]] = poolName;
    }
  }
  // Inherit pool from base for upgraded starter relics
  const upgrades = parseStarterUpgrades(relicsDir);
  for (const [upgraded, base] of Object.entries(upgrades)) {
    if (map[base] && !map[upgraded]) map[upgraded] = map[base];
  }
  return map;
}

// ── Per-relic ───────────────────────────────────────────────────────────────

const RARITY_BASE_COST = { Common: 175, Uncommon: 225, Rare: 275, Shop: 200 };

const NAME_VARIANT_CHARS = {
  IRONCLAD:    'Ironclad',
  SILENT:      'Silent',
  DEFECT:      'Defect',
  NECROBINDER: 'Necrobinder',
  REGENT:      'Regent',
};

const VARIANT_SUFFIXES = {
  ironclad:    'Ironclad',
  silent:      'Silent',
  defect:      'Defect',
  necrobinder: 'Necrobinder',
  regent:      'Regent',
};

function imageNameIfExists(dir, base) {
  if (!dir) return null;
  for (const ext of ['webp', 'png']) {
    const fp = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(fp)) return `${base}.${ext}`;
  }
  return null;
}

function parseSingleRelic(filepath, localization, relicPools, enchLoc, imagesDir) {
  const className = path.basename(filepath, '.cs');
  if (className.startsWith('Deprecated') || className.startsWith('Mock')) return null;

  const content = fs.readFileSync(filepath, 'utf8');

  // Skip non-relic classes that happen to live in this folder
  if (!/class\s+\w+\s*:\s*RelicModel\b/.test(content)) return null;

  const relicId = classNameToId(className);

  // Decompilers vary on getter style: ILSpy emits `Rarity => RelicRarity.X;`
  // while dnSpy expands the same property to `{ get { return RelicRarity.X; } }`.
  // Accept either; capture group 1 is the rarity name in both cases.
  const rarityM = content.match(/Rarity\s*=>\s*RelicRarity\.(\w+)/)
               || content.match(/Rarity\b[\s\S]{0,200}?return\s+RelicRarity\.(\w+)/);
  const rarity  = rarityM ? rarityM[1] : 'Unknown';

  const allVars = extractVarsFromSource(content);

  // StringVar references to enchantment names (resolves "{Enchantment}" tokens
  // in descriptions like "Apply {Enchantment} to a card.")
  for (const sv of content.matchAll(/StringVar\(\s*"(\w+)"\s*,\s*ModelDb\.Enchantment<(\w+)>\(\)/g)) {
    const varName = sv[1], enchClass = sv[2];
    const enchId  = classNameToId(enchClass);
    let enchName  = camelToSpaced(enchClass);
    if (enchLoc) {
      const locName = enchLoc[`${enchId}.title`];
      if (locName) enchName = locName;
    }
    allVars[varName] = enchName;
  }

  const title          = localization[`${relicId}.title`]       || className;
  const descriptionRaw = localization[`${relicId}.description`] || '';
  const flavor         = localization[`${relicId}.flavor`]      || '';

  const nameVariants = {};
  for (const [charKey, charLabel] of Object.entries(NAME_VARIANT_CHARS)) {
    const v = localization[`${relicId}.${charKey}.title`];
    if (v && v !== title) nameVariants[charLabel] = v;
  }

  const description = resolveDescription(descriptionRaw, allVars, false);

  // Merchant cost — base from rarity / explicit override, ±15% variance.
  // Both compact (`=> X;`) and expanded (`{ get { return X; } }`) forms accepted.
  const isShopBlacklisted = /IsAllowedInShops\s*=>\s*false\b/.test(content)
                         || /IsAllowedInShops\b[\s\S]{0,150}?return\s+false\b/.test(content);
  const overrideM = content.match(/MerchantCost\s*=>\s*(\d+)/)
                 || content.match(/MerchantCost\b[\s\S]{0,150}?return\s+(\d+)/);
  let baseCost = overrideM ? parseInt(overrideM[1], 10) : (RARITY_BASE_COST[rarity] ?? null);
  let merchantPrice = null;
  if (!isShopBlacklisted && baseCost != null) {
    merchantPrice = { base: baseCost, min: Math.round(baseCost * 0.85), max: Math.round(baseCost * 1.15) };
  }

  const pool = relicPools[className] || 'shared';

  const baseLower = relicId.toLowerCase();
  let imageFile = imageNameIfExists(imagesDir, baseLower);

  // Character image variants
  const imageVariants = {};
  for (const [suffix, charName] of Object.entries(VARIANT_SUFFIXES)) {
    const v = imageNameIfExists(imagesDir, `${baseLower}_${suffix}`);
    if (v) imageVariants[charName] = v;
  }
  // Some relics (Yummy Cookie) only ship as character variants — no base
  // image. Fall back to whichever variant is alphabetically first so the
  // renderer always has something to show.
  if (!imageFile && Object.keys(imageVariants).length) {
    const firstKey = Object.keys(imageVariants).sort()[0];
    imageFile = imageVariants[firstKey];
  }
  // Looming Fruit ships two icons (cornucopia + bare fruit)
  if (className === 'LoomingFruit') {
    if (imageFile) imageVariants.Cornucopia = imageFile;
    const fruitV = imageNameIfExists(imagesDir, `${baseLower}_2`);
    if (fruitV) imageVariants.Fruit = fruitV;
  }

  return {
    id: relicId,
    name: title,
    description,
    description_raw: descriptionRaw,
    flavor,
    rarity,
    pool,
    merchant_price: merchantPrice,
    image_file: imageFile,
    image_variants: Object.keys(imageVariants).length ? imageVariants : null,
    name_variants:  Object.keys(nameVariants).length  ? nameVariants  : null,
  };
}

// ── Rarity translation ──────────────────────────────────────────────────────

function buildRelicRarityMap(gameplayUi) {
  return {
    Starter:  gameplayUi['RELIC_RARITY.STARTER']  || 'Starter',
    Common:   gameplayUi['RELIC_RARITY.COMMON']   || 'Common',
    Uncommon: gameplayUi['RELIC_RARITY.UNCOMMON'] || 'Uncommon',
    Rare:     gameplayUi['RELIC_RARITY.RARE']     || 'Rare',
    Ancient:  gameplayUi['RELIC_RARITY.ANCIENT']  || 'Ancient',
    Event:    gameplayUi['RELIC_RARITY.EVENT']    || 'Event',
    Shop:     gameplayUi['RELIC_RARITY.SHOP']     || 'Shop',
    None:     gameplayUi['RELIC_RARITY.NONE']     || 'Relic',
  };
}

const RELIC_RARITY_ORDER = ['Starter', 'Common', 'Uncommon', 'Rare', 'Shop', 'Ancient', 'Event'];

// ── Main ────────────────────────────────────────────────────────────────────

function parseAllRelics({ decompiledRoot, locDir, imagesDir }) {
  const relicsDir     = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Relics');
  const relicPoolsDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.RelicPools');
  if (!relicsDir) {
    console.warn(`Relics namespace not found under ${decompiledRoot}`);
    return [];
  }

  const localization = readJsonOrEmpty(path.join(locDir, 'relics.json'));
  const enchLoc      = readJsonOrEmpty(path.join(locDir, 'enchantments.json'));
  const gameplayUi   = readJsonOrEmpty(path.join(locDir, 'gameplay_ui.json'));
  const relicPools   = parseRelicPools(relicPoolsDir, relicsDir);

  const rarityMap   = buildRelicRarityMap(gameplayUi);
  const rarityIndex = Object.fromEntries(
    RELIC_RARITY_ORDER.map((r, i) => [rarityMap[r] || r, i])
  );

  const files = fs.readdirSync(relicsDir).filter(f => f.endsWith('.cs')).sort();
  const relics = [];
  for (const f of files) {
    const r = parseSingleRelic(path.join(relicsDir, f), localization, relicPools, enchLoc, imagesDir);
    if (r) {
      r.rarity_key = r.rarity;
      r.rarity     = rarityMap[r.rarity] || r.rarity;
      relics.push(r);
    }
  }

  relics.sort((a, b) => {
    const ra = rarityIndex[a.rarity] ?? 99;
    const rb = rarityIndex[b.rarity] ?? 99;
    return ra - rb || a.name.localeCompare(b.name);
  });
  relics.forEach((r, i) => { r.compendium_order = i; });
  relics.sort((a, b) => a.name.localeCompare(b.name));
  return relics;
}

module.exports = { parseAllRelics, parseSingleRelic, classNameToId };
