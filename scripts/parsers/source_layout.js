'use strict';
/**
 * source_layout.js — Resolve a C# namespace to its on-disk directory in the
 * decompiled output. Supports both decompiler layouts the project deals with:
 *
 *   ILSpy   →  <root>/MegaCrit.Sts2.Core.Models.Cards/
 *              (one flat dir per namespace, dots in the name)
 *
 *   dnSpy   →  <root>/sts2/MegaCrit/Sts2/Core/Models/Cards/
 *              (path-style nesting, optional assembly-named outermost dir,
 *               case may differ from C# namespace per dnSpy's preferences)
 *
 * Both decompilers are common, and which one we use depends on what's
 * available without forcing the user to install .NET SDK. Rather than locking
 * the parsers to a single decompiler, this helper tries both layouts case-
 * insensitively and returns the first match.
 */

const fs   = require('fs');
const path = require('path');

function existsCaseInsensitive(parent, name) {
  if (!fs.existsSync(parent)) return null;
  const target = name.toLowerCase();
  for (const entry of fs.readdirSync(parent)) {
    if (entry.toLowerCase() === target) return path.join(parent, entry);
  }
  return null;
}

// Walk the parts, taking each match case-insensitively. Returns the resolved
// path or null if any part isn't found.
function joinCaseInsensitive(start, parts) {
  let cur = start;
  for (const part of parts) {
    cur = existsCaseInsensitive(cur, part);
    if (!cur) return null;
  }
  return cur;
}

/**
 * Find the directory holding `<dottedNamespace>` under `decompiledRoot`.
 * Returns an absolute path or null.
 */
function resolveNamespaceDir(decompiledRoot, dottedNamespace) {
  if (!fs.existsSync(decompiledRoot)) return null;
  const parts = dottedNamespace.split('.');

  // 1. ILSpy flat layout: a single dir whose name is the dotted namespace.
  const flat = existsCaseInsensitive(decompiledRoot, dottedNamespace);
  if (flat && fs.statSync(flat).isDirectory()) return flat;

  // 2. dnSpy nested at root: <root>/<part1>/<part2>/...
  const direct = joinCaseInsensitive(decompiledRoot, parts);
  if (direct && fs.statSync(direct).isDirectory()) return direct;

  // 3. dnSpy with assembly-named outer dir: <root>/<assembly>/<part1>/<part2>/...
  for (const e of fs.readdirSync(decompiledRoot)) {
    const sub = path.join(decompiledRoot, e);
    if (!fs.statSync(sub).isDirectory()) continue;
    const nested = joinCaseInsensitive(sub, parts);
    if (nested && fs.statSync(nested).isDirectory()) return nested;
  }

  return null;
}

module.exports = { resolveNamespaceDir };
