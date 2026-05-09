'use strict';
/**
 * enchantment_parser.js — JS port of
 *   spire-codex/backend/app/parsers/enchantment_parser.py
 *
 * Reads:
 *   <decompiled>/MegaCrit.Sts2.Core.Models.Enchantments/*.cs
 *   <raw>/localization/<lang>/enchantments.json
 *
 * Writes a JS array of enchantment objects with description, restrictions,
 * card-type targeting, and stackability flags.
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

function parseCardTypeRestriction(content) {
  // CanEnchantCardType(CardType …) { … cardType == CardType.Attack
  const eqM = content.match(/CanEnchantCardType\(CardType\s+\w+\)\s*\{[^}]*cardType\s*==\s*CardType\.(\w+)/s);
  if (eqM) return eqM[1];
  // Decompiled range check: (uint)(cardType - 1) <= 1u  → Attack | Skill
  if (/CanEnchantCardType.*\(uint\)\(cardType\s*-\s*1\)\s*<=\s*1u/s.test(content)) return 'Attack, Skill';
  return null;
}

function parseApplicableTo(content) {
  // Capture the body of override bool CanEnchant(CardModel …) up to the
  // next class member declaration.
  const m = content.match(/override\s+bool\s+CanEnchant\(CardModel\s+\w+\)\s*\{([\s\S]*?)(?=\n\t(?:public|protected|private)\s|\n\})/);
  if (!m) return null;
  const body = m[1];

  const restrictions = [];

  const tags = [...body.matchAll(/Tags\.Contains\(CardTag\.(\w+)\)/g)].map(x => x[1]);
  if (tags.length) restrictions.push(tags.join(', ') + ' cards');

  const rarityM = body.match(/Rarity\s*==\s*CardRarity\.(\w+)/);
  if (rarityM) restrictions.unshift(rarityM[1]);

  const kw = [...body.matchAll(/Keywords\.Contains\(CardKeyword\.(\w+)\)/g)]
    .map(x => x[1]).filter(k => k !== 'Unplayable');
  if (kw.length) restrictions.push('cards with ' + kw.join(', '));

  if (body.includes('GainsBlock')) restrictions.push('cards that gain Block');

  return restrictions.length ? restrictions.join(' ') : null;
}

function parseSingleEnchantment(filepath, localization, imagesDir) {
  const className = path.basename(filepath, '.cs');
  if (className.startsWith('Deprecated') || className.startsWith('Mock')) return null;

  const content = fs.readFileSync(filepath, 'utf8');
  const enchId  = classNameToId(className);

  const allVars = extractVarsFromSource(content);

  // Enchantments using `base.Amount` get a runtime-set value; show "X" so
  // descriptions like "Adroit 5" don't collapse to "Adroit ".
  if (/base\.Amount/.test(content)) {
    allVars.Amount = 'X';
    for (const rm of content.matchAll(/DynamicVars\.(\w+)\.BaseValue\s*=\s*base\.Amount/g)) {
      allVars[rm[1]] = 'X';
    }
  }

  const title          = localization[`${enchId}.title`]          || className;
  const descriptionRaw = localization[`${enchId}.description`]    || '';
  const extraRaw       = localization[`${enchId}.extraCardText`]  || '';

  const description = resolveDescription(descriptionRaw, allVars, false);
  const extra       = extraRaw ? resolveDescription(extraRaw, allVars, false) : null;

  const cardType     = parseCardTypeRestriction(content);
  const applicableTo = parseApplicableTo(content);
  // Compact ILSpy form OR expanded dnSpy `{ get { return true; } }`.
  const isStackable  = /IsStackable\s*=>\s*true/.test(content)
                    || /IsStackable\b[\s\S]{0,150}?return\s+true/.test(content);

  let imageFile = null;
  if (imagesDir) {
    const base = enchId.toLowerCase();
    for (const ext of ['webp', 'png']) {
      const candidate = path.join(imagesDir, `${base}.${ext}`);
      if (fs.existsSync(candidate)) { imageFile = `${base}.${ext}`; break; }
    }
  }

  return {
    id: enchId,
    name: title,
    description,
    description_raw: descriptionRaw !== description ? descriptionRaw : null,
    extra_card_text: extra,
    card_type: cardType,
    applicable_to: applicableTo,
    is_stackable: isStackable,
    image_file: imageFile,
  };
}

function parseAllEnchantments({ decompiledRoot, locDir, imagesDir }) {
  const sourceDir = resolveNamespaceDir(decompiledRoot, 'MegaCrit.Sts2.Core.Models.Enchantments');
  if (!sourceDir) {
    console.warn(`Enchantments namespace not found under ${decompiledRoot}`);
    return [];
  }
  const localization = readJsonOrEmpty(path.join(locDir, 'enchantments.json'));
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.cs')).sort();
  const out = [];
  for (const f of files) {
    const e = parseSingleEnchantment(path.join(sourceDir, f), localization, imagesDir);
    if (e) out.push(e);
  }
  return out;
}

module.exports = { parseAllEnchantments, parseSingleEnchantment, classNameToId };
