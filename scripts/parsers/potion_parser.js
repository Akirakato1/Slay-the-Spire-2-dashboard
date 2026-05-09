'use strict';
/**
 * potion_parser.js — JS port of
 *   spire-codex/backend/app/parsers/potion_parser.py
 *
 * Reads:
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Potions/*.cs
 *   <raw>/localization/<lang>/potions.json
 *   <raw>/localization/<lang>/gameplay_ui.json
 *
 * Writes a JS array of potion objects:
 *   { id, name, description, description_raw, rarity, rarity_key, image_url,
 *     compendium_order, image_file? }
 *
 * `image_url`/`image_file` are populated when an image asset exists in the
 * extracted PCK output; otherwise null/undefined.
 */

const fs   = require('fs');
const path = require('path');
const { resolveDescription, extractVarsFromSource } = require('./description_resolver.js');
const { resolveNamespaceDir } = require('./source_layout.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

// "MyClassName" → "MY_CLASS_NAME". Matches the Python regex pair used by
// every parser in the spire-codex package.
function classNameToId(name) {
  let s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  s = s.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
  return s.toUpperCase();
}

function readJsonOrEmpty(filepath) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.warn(`  could not parse ${filepath}: ${e.message}`);
  }
  return {};
}

// ── Per-potion ──────────────────────────────────────────────────────────────

function parseSinglePotion(filepath, localization, imagesDir) {
  const className = path.basename(filepath, '.cs');

  if (className.startsWith('Deprecated') || className.startsWith('Mock')) return null;

  const content = fs.readFileSync(filepath, 'utf8');
  const potionId = classNameToId(className);

  // Compact ILSpy form vs expanded dnSpy form — accept either.
  const rarityM = content.match(/Rarity\s*=>\s*PotionRarity\.(\w+)/)
               || content.match(/Rarity\b[\s\S]{0,200}?return\s+PotionRarity\.(\w+)/);
  const rarity  = rarityM ? rarityM[1] : 'Common';

  const allVars = extractVarsFromSource(content);

  const title          = localization[`${potionId}.title`]       || className;
  const descriptionRaw = localization[`${potionId}.description`] || '';
  const description    = resolveDescription(descriptionRaw, allVars, false);

  // Image — prefer .webp, fall back to .png. The image directory is the
  // image-extraction output produced by GDRE; if it doesn't exist we just
  // emit null (the renderer falls back to a placeholder).
  let imageFile = null;
  if (imagesDir) {
    const base = potionId.toLowerCase();
    for (const ext of ['webp', 'png']) {
      const candidate = path.join(imagesDir, `${base}.${ext}`);
      if (fs.existsSync(candidate)) { imageFile = `${base}.${ext}`; break; }
    }
  }

  return {
    id: potionId,
    name: title,
    description,
    description_raw: descriptionRaw,
    rarity,
    image_file: imageFile,
  };
}

// ── Rarity translation (per-language UI strings) ────────────────────────────

function buildPotionRarityMap(gameplayUi) {
  return {
    Common:   gameplayUi['POTION_RARITY.COMMON']   || 'Common',
    Uncommon: gameplayUi['POTION_RARITY.UNCOMMON'] || 'Uncommon',
    Rare:     gameplayUi['POTION_RARITY.RARE']     || 'Rare',
    Event:    gameplayUi['POTION_RARITY.EVENT']    || 'Event',
    Token:    gameplayUi['POTION_RARITY.TOKEN']    || 'Token',
  };
}

const POTION_RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Event', 'Token'];

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   decompiledRoot — path to the ILSpy decompile root (contains the
 *                    "MegaCrit.Sts2.Core.Models.Potions" subdir)
 *   locDir         — path to <raw>/localization/<lang>
 *   imagesDir      — path to extracted potion images, or null
 */
function parseAllPotions({ decompiledRoot, locDir, imagesDir }) {
  const sourceDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Potions');
  if (!sourceDir) {
    console.warn(`Potions namespace not found under ${decompiledRoot}`);
    return [];
  }
  const localization = readJsonOrEmpty(path.join(locDir, 'potions.json'));
  const gameplayUi   = readJsonOrEmpty(path.join(locDir, 'gameplay_ui.json'));
  const rarityMap    = buildPotionRarityMap(gameplayUi);
  const rarityIndex  = Object.fromEntries(
    POTION_RARITY_ORDER.map((r, i) => [rarityMap[r] || r, i])
  );

  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.cs')).sort();
  const potions = [];
  for (const f of files) {
    const p = parseSinglePotion(path.join(sourceDir, f), localization, imagesDir);
    if (p) {
      p.rarity_key = p.rarity;
      p.rarity     = rarityMap[p.rarity] || p.rarity;
      potions.push(p);
    }
  }

  // Compendium order: rarity bucket → alphabetical within bucket
  potions.sort((a, b) => {
    const ra = rarityIndex[a.rarity] ?? 99;
    const rb = rarityIndex[b.rarity] ?? 99;
    return ra - rb || a.name.localeCompare(b.name);
  });
  potions.forEach((p, i) => { p.compendium_order = i; });

  // Default sort = alphabetical for downstream consumers
  potions.sort((a, b) => a.name.localeCompare(b.name));
  return potions;
}

module.exports = { parseAllPotions, parseSinglePotion, classNameToId };
