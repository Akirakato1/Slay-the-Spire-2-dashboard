'use strict';
/**
 * simplifier.js — Condense the verbose parser output into the dashboard's
 * "render-ready" schema. The parsers preserve every field the original
 * spire-codex extraction produced; this layer trims to what the dashboard's
 * card/relic/potion/event/enchantment views actually need.
 *
 * Schemas are exactly as called out in the user spec — see each function for
 * the field-by-field mapping.
 */

const fs   = require('fs');
const path = require('path');

// "ironclad" → "Ironclad", "shared" → "Any" (relic-only convention)
function capitalizeColor(c) {
  if (!c) return null;
  if (c === 'shared') return 'Any';
  return c[0].toUpperCase() + c.slice(1);
}

// ── Keyword text injection ─────────────────────────────────────────────────
// spire-codex's parser pulls each card's `description` from a loc key but
// never adds the visible-keyword text (Unplayable, Innate, Exhaust, etc.)
// the game appends at render time. Without this step ~145 cards display the
// wrong text and the 13 keyword-only curses/statuses appear blank entirely.
//
// Order below matches in-game card layout: Unplayable goes BEFORE the body;
// the rest stack AFTER it in this order. `Sly` is a hidden tag (used by
// effects that count "Sly cards played") and is not rendered on cards.

// In-game ordering: Unplayable + Innate sit ABOVE the body text (they're
// pre-play / opening-hand metadata). Ethereal / Retain / Sly / Exhaust /
// Eternal hang BELOW the body — they describe what happens after the card
// resolves or what the card does in the discard / exhaust pile. Sly tags
// Silent cards that count for "Sly cards played this turn" effects.
const KW_BEFORE = ['Unplayable', 'Innate'];
const KW_AFTER  = ['Ethereal', 'Retain', 'Sly', 'Exhaust', 'Eternal'];

function _hasKeyword(desc, kw) {
  return new RegExp(`\\b${kw}\\.`, 'i').test(desc || '');
}

function injectKeywords(description, keywords) {
  if (!keywords || keywords.length === 0) return description || '';
  const set = new Set(keywords);
  const desc = description || '';
  const before = KW_BEFORE.filter(k => set.has(k) && !_hasKeyword(desc, k));
  const after  = KW_AFTER .filter(k => set.has(k) && !_hasKeyword(desc, k));
  if (before.length === 0 && after.length === 0) return desc;
  // Wrap each keyword in [gold]…[/gold] so the renderer paints it gold —
  // matches the in-game display, where keywords like "Exhaust." sit at the
  // bottom of the description in the same gold the body uses for keyword
  // *references* (e.g. [gold]Vulnerable[/gold]). Style is consistent.
  const wrap = (k) => `[gold]${k}.[/gold]`;
  const parts = [];
  if (before.length)   parts.push(before.map(wrap).join('\n'));
  if (desc.trim())     parts.push(desc);
  if (after.length)    parts.push(after.map(wrap).join('\n'));
  return parts.join('\n');
}

// Upgrade-time keyword adjustments. The `keywords` array on the parser side
// only reflects the *base* card; cards whose upgrade adds or removes a
// keyword carry it in `upgrade.add_<kw>` / `upgrade.remove_<kw>` instead.
// Without applying these, ~16 cards (Afterimage, Tyranny, Big Bang …) lose
// their Innate on the upgraded variant, and 17 cards keep Exhaust that the
// upgrade was supposed to remove.
const UPGRADE_KW_ADD = {
  add_innate:   'Innate',
  add_retain:   'Retain',
  add_exhaust:  'Exhaust',
  add_ethereal: 'Ethereal',
};
const UPGRADE_KW_REMOVE = {
  remove_innate:   'Innate',
  remove_retain:   'Retain',
  remove_exhaust:  'Exhaust',
  remove_ethereal: 'Ethereal',
};

function computeUpgradedKeywords(baseKeywords, upgrade) {
  const set = new Set(baseKeywords || []);
  if (upgrade && typeof upgrade === 'object') {
    for (const [flag, kw] of Object.entries(UPGRADE_KW_ADD))    if (upgrade[flag]) set.add(kw);
    for (const [flag, kw] of Object.entries(UPGRADE_KW_REMOVE)) if (upgrade[flag]) set.delete(kw);
  }
  return [...set];
}

// Some extracted cards (Scrawl, Calculated Gamble, Royal Gamble) have a
// self-contradicting `keywords` array that includes a keyword the upgrade
// also claims to *add* via `upgrade.add_<kw>`. By definition, an add_<kw>
// upgrade flag means the keyword is NOT on the base card — strip it out
// so injectKeywords doesn't paint it onto the base description.
function computeBaseKeywords(parserKeywords, upgrade) {
  const set = new Set(parserKeywords || []);
  if (upgrade && typeof upgrade === 'object') {
    for (const [flag, kw] of Object.entries(UPGRADE_KW_ADD)) {
      if (upgrade[flag]) set.delete(kw);
    }
  }
  return [...set];
}

// ── Cards ───────────────────────────────────────────────────────────────────
//
// {
//   name, character, rarity, type, canUpgrade, multiplayer,
//   description, descriptionUpgraded, manaCost, manaCostUpgraded, imageFile
// }
//
// `descriptionUpgraded` is left empty when the upstream parser produces no
// explicit upgrade text — that's true for cards whose upgrade only changes
// non-text properties (cost, innate flag, etc). Renderers should fall back
// to `description` in that case. `manaCostUpgraded` carries the upgraded
// cost when `extracted.upgrade.cost` is present, so visual upgraded variants
// can show the new orb number even when the text is identical.

function simplifyCards(parsed) {
  return parsed.map(c => {
    // Cards like Mad Science have no single portrait — only per-CardType
    // variants under `type_variants[<type>].image_file`. Pick the variant
    // matching the card's declared type, falling back to the first that
    // has art so we never lose the visual entirely.
    let imageFile = c.image_file;
    if (!imageFile && c.type_variants) {
      const declared = (c.type_key || c.type || '').toLowerCase();
      imageFile = c.type_variants[declared]?.image_file
        || Object.values(c.type_variants).find(v => v && v.image_file)?.image_file
        || null;
    }
    const baseCost = typeof c.cost === 'number' ? c.cost : null;
    const upgradeCost = c.upgrade && typeof c.upgrade.cost === 'number' ? c.upgrade.cost : null;
    // Star cost convention: -1 = no star cost, 'X' = variable, N = N stars.
    // No card observed (yet) where upgrade alters star_cost, so the upgraded
    // variant inherits the base value.
    let starCost;
    if (c.is_x_star_cost) starCost = 'X';
    else if (typeof c.star_cost === 'number') starCost = c.star_cost;
    else starCost = -1;
    return {
      name:                c.name,
      character:           capitalizeColor(c.color) || 'Unknown',
      rarity:              c.rarity_key || c.rarity || 'Unknown',
      type:                c.type_key   || c.type   || 'Unknown',
      canUpgrade:          !!(c.upgrade || c.upgrade_description),
      multiplayer:         false,                       // not yet extracted by parser
      description:         injectKeywords(c.description || '', computeBaseKeywords(c.keywords, c.upgrade)),
      // Upgraded description body falls back to the base description when
      // the parser produced no rewrite (cost / keyword-only upgrades). The
      // keyword set is recomputed from base ± upgrade.add_*/remove_* so
      // upgrade-only keywords like Innate appear correctly on the variant.
      descriptionUpgraded: injectKeywords(
        c.upgrade_description || c.description || '',
        computeUpgradedKeywords(c.keywords, c.upgrade),
      ),
      manaCost:            baseCost,
      manaCostUpgraded:    upgradeCost != null ? upgradeCost : baseCost,
      starCost,
      starCostUpgraded:    starCost,
      imageFile:           imageFile ? `cards/${imageFile}` : null,
      // Multi-type cards (Mad Science) ship 3 type variants × 3 riders =
      // 9 distinct visual+text combinations. The parser emits a base
      // description per variant plus a `riders` array; the actual variant
      // a player gets is recorded as TinkerTimeRider (0..8) on the run's
      // card props. Preserve the structure so the renderer can pick the
      // correct variant + rider per card instance. Null for normal cards.
      typeVariants:        c.type_variants ? Object.fromEntries(
        Object.entries(c.type_variants).map(([k, v]) => [k, {
          type:        v && v.type || null,
          description: (v && v.description) || '',
          imageFile:   v && v.image_file ? `cards/${v.image_file}` : null,
          riders:      (v && Array.isArray(v.riders)) ? v.riders.map(r => ({
            id:          r && r.id || null,
            name:        r && r.name || null,
            description: (r && r.description) || '',
          })) : [],
        }])
      ) : null,
    };
  });
}

// ── Relics ──────────────────────────────────────────────────────────────────
//
// { name, rarity, character, description, imageFile }
//
// `pool` (from the parser's RelicPools scan) is the source of truth for
// character — character pools map directly to character names; everything
// else (shared / event / fallback / no pool) maps to "Any".
// `rarity_key` comes from each relic's `Rarity` property and is one of:
//   Starter / Common / Uncommon / Rare / Shop / Event / Ancient / None.

const RELIC_CHARACTER_POOLS = new Set(['ironclad', 'silent', 'defect', 'necrobinder', 'regent']);

function simplifyRelics(parsed) {
  return parsed.map(r => {
    const rarity = r.rarity_key || r.rarity || 'Unknown';
    const pool   = r.pool || 'shared';
    const character = RELIC_CHARACTER_POOLS.has(pool)
      ? capitalizeColor(pool)
      : 'Any';
    return {
      name:        r.name,
      rarity,
      character,
      description: r.description || '',
      imageFile:   r.image_file ? `relics/${r.image_file}` : null,
    };
  });
}

// ── Potions ─────────────────────────────────────────────────────────────────
//
// { name, rarity, description, imageFile }
//
// Potions in STS2 don't appear to be character-locked at this layer — the
// parser doesn't expose a character field. Skipping it.

function simplifyPotions(parsed) {
  return parsed.map(p => ({
    name:        p.name,
    rarity:      p.rarity_key || p.rarity || 'Unknown',
    description: p.description || '',
    imageFile:   p.image_file ? `potions/${p.image_file}` : null,
  }));
}

// ── Enchantments ────────────────────────────────────────────────────────────
//
// { name, description, applicableTo, isStackable, imageFile }
//
// `applicable_to` (e.g. "Common cards with Exhaust", "Attack, Skill cards")
// is the only enchantment-specific field we keep — describes what cards the
// enchantment can be applied to.

function simplifyEnchantments(parsed) {
  return parsed.map(e => ({
    name:         e.name,
    description:  e.description || '',
    applicableTo: e.applicable_to || e.card_type || null,
    isStackable:  !!e.is_stackable,
    imageFile:    e.image_file ? `enchantments/${e.image_file}` : null,
  }));
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// { name, type, act, description, imageFile }
//
// `type` is "Event" / "Ancient" / "Shared". `act` is the act the event
// belongs to (or null for events that aren't tied to a specific act, like
// Ancients which are visited from a separate node type).

function simplifyEvents(parsed) {
  return parsed.map(ev => {
    // Ancient images live under `ancients/`, regular events under `events/`.
    let imagePrefix = 'events';
    if (ev.type === 'Ancient') imagePrefix = 'ancients';
    return {
      name:        ev.name,
      type:        ev.type || 'Event',
      act:         ev.act  || null,
      description: ev.description || '',
      imageFile:   ev.image_file ? `${imagePrefix}/${ev.image_file}` : null,
    };
  });
}

// ── Driver ──────────────────────────────────────────────────────────────────

/**
 * Read the parser-output JSON files, simplify each, write to `outDir`.
 * @param {string} fromDir  e.g. "<userData>/Assets/data-extracted/eng"
 * @param {string} outDir   e.g. "<userData>/Assets/data-simplified/eng"
 */
function simplifyAll(fromDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const SPECS = [
    { name: 'cards',        fn: simplifyCards },
    { name: 'relics',       fn: simplifyRelics },
    { name: 'potions',      fn: simplifyPotions },
    { name: 'events',       fn: simplifyEvents },
    { name: 'enchantments', fn: simplifyEnchantments },
  ];

  const counts = {};
  for (const spec of SPECS) {
    const inPath = path.join(fromDir, `${spec.name}.json`);
    if (!fs.existsSync(inPath)) { counts[spec.name] = 0; continue; }
    const parsed = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const simplified = spec.fn(parsed);
    fs.writeFileSync(path.join(outDir, `${spec.name}.json`), JSON.stringify(simplified, null, 2), 'utf8');
    counts[spec.name] = simplified.length;
  }
  return counts;
}

module.exports = {
  simplifyCards, simplifyRelics, simplifyPotions, simplifyEnchantments, simplifyEvents,
  simplifyAll,
};
