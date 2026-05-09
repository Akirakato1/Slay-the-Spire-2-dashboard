'use strict';
/**
 * description_resolver.js — JS port of
 *   spire-codex/backend/app/parsers/description_resolver.py
 *
 * Resolves SmartFormat templates in card / relic / potion / event localization
 * strings. Two entry points:
 *   resolveDescription(raw, vars, isUpgraded)  → readable string
 *   extractVarsFromSource(csharpSource)        → { varName: number, … }
 *
 * Behavior matches the Python original: same template features, same
 * variable-extraction patterns, same fallback when a value is missing
 * (`[VarName]` placeholder for downstream BBCode-ish rendering).
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function lookup(name, vars, fallback) {
  if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  if (vars) {
    const lname = String(name).toLowerCase();
    for (const [k, v] of Object.entries(vars)) {
      if (k.toLowerCase() === lname) return v;
    }
  }
  return fallback;
}

// Split string on `|` at brace depth 0 (so {a|b} stays grouped).
function splitPipesAtDepth0(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Walk forward from position `start` (which holds the opening { of a token
// the caller has already located) through nested {…}. `start` should point
// to the character AFTER the opening { we want matched. Returns index of
// the matching closing } (one past the }), or -1 if unbalanced.
function findMatchingBrace(text, start) {
  let depth = 1, i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── resolveDescription ──────────────────────────────────────────────────────

function resolveDescription(raw, vars, isUpgraded = false) {
  vars = vars || {};
  let text = String(raw || '');

  // {Var:choose(Option1|Option2|...):result1|result2|...}
  // Pick the branch matching the variable's value; fall back to first.
  text = (function resolveAllChoose(t) {
    while (true) {
      const m = t.match(/\{(\w+):choose\(([^)]+)\):/);
      if (!m) return t;
      const start = m.index;
      const varName = m[1];
      const options = m[2].split('|');
      const restStart = m.index + m[0].length;
      const closeIdx = findMatchingBrace(t, restStart);
      if (closeIdx < 0) return t;
      const inner = t.slice(restStart, closeIdx - 1);
      const branches = splitPipesAtDepth0(inner);
      const val = lookup(varName, vars);
      let result = null;
      if (val !== undefined && val !== null) {
        const valStr = String(val).trim().toLowerCase();
        for (let idx = 0; idx < options.length; idx++) {
          if (options[idx].trim().toLowerCase() === valStr && idx < branches.length) {
            result = branches[idx];
            break;
          }
        }
      }
      if (result === null && branches.length) result = branches[0];
      t = t.slice(0, start) + (result || '') + t.slice(closeIdx);
    }
  })(text);

  // {IfUpgraded:show:A|B} or {IfUpgraded:show:A}
  text = (function resolveAllIfUpgraded(t) {
    const tag = '{IfUpgraded:show:';
    while (true) {
      const idx = t.indexOf(tag);
      if (idx < 0) return t;
      const restStart = idx + tag.length;
      const closeIdx = findMatchingBrace(t, restStart);
      if (closeIdx < 0) return t;
      const inner = t.slice(restStart, closeIdx - 1);
      const parts = splitPipesAtDepth0(inner);
      const trueVal  = parts[0] || '';
      const falseVal = parts[1] || '';
      const result = isUpgraded ? trueVal : falseVal;
      t = t.slice(0, idx) + result + t.slice(closeIdx);
    }
  })(text);

  // {Var:energyIcons()} or {Var:energyIcons(N)} → [energy:N]
  text = text.replace(/\{(\w+):energyIcons\((\d*)\)\}/g, (_, varName, explicit) => {
    if (explicit) return `[energy:${explicit}]`;
    const v = vars[varName];
    return `[energy:${v != null ? v : 1}]`;
  });

  // {Var:starIcons()} → [star:N]
  text = text.replace(/\{(\w+):starIcons\(\)\}/g, (_, varName) => {
    const v = vars[varName];
    return `[star:${v != null ? v : 1}]`;
  });

  // {SingleStarIcon} → [star:1]
  text = text.replace(/\{SingleStarIcon\}/gi, '[star:1]');

  // {Var:plural:singular|plural} — replaces inline {} with the value
  text = (function resolveAllPlurals(t) {
    while (true) {
      const m = t.match(/\{(\w+):plural:/);
      if (!m) return t;
      const start = m.index;
      const varName = m[1];
      const restStart = m.index + m[0].length;
      const closeIdx = findMatchingBrace(t, restStart);
      if (closeIdx < 0) return t;
      const inner = t.slice(restStart, closeIdx - 1);
      const pipeIdx = inner.indexOf('|');
      const singular = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
      const plural   = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : '';
      const val = lookup(varName, vars, 2);
      let result = (val === 1) ? singular : plural;
      result = result.replace(/\{\}/g, String(val));
      result = result.replace(/\{:\w+\(\)\}/g, String(val)); // self-references
      t = t.slice(0, start) + result + t.slice(closeIdx);
    }
  })(text);

  // {Var:cond:…} — comparison or simple truthy/falsy conditionals
  text = (function resolveAllCond(t) {
    while (true) {
      const m = t.match(/\{([\w.]+):cond:/);
      if (!m) return t;
      const start = m.index;
      const varName = m[1];
      const restStart = m.index + m[0].length;
      const closeIdx = findMatchingBrace(t, restStart);
      if (closeIdx < 0) return t;
      const inner = t.slice(restStart, closeIdx - 1);
      const parts = splitPipesAtDepth0(inner);
      const baseVar = varName.split('.')[0];
      const val = lookup(baseVar, vars);

      let result = '';
      if (parts.some(p => /[><=!]+\d+\?/.test(p))) {
        // comparison-based
        let matched = false;
        for (const part of parts) {
          const cm = part.match(/^([><=!]+\d+)\?(.*)$/s);
          if (cm) {
            if (!matched && evalCond(cm[1], typeof val === 'number' ? val : 0)) {
              result = cm[2];
              matched = true;
            }
          } else if (!matched) {
            result = part;
            matched = true;
          }
        }
      } else {
        // truthy / falsy
        const trueVal  = parts[0] || '';
        const falseVal = parts[1] || '';
        result = (val !== null && val !== undefined && val) ? trueVal : falseVal;
      }
      t = t.slice(0, start) + result + t.slice(closeIdx);
    }
  })(text);

  // {Var:trueValue|falseValue} — nested-brace-tolerant simple conditional.
  // We must NOT match the named formatters (choose/cond/diff/etc.) here.
  text = (function resolveAllNestedCond(t) {
    const guard = /\{(\w[\w.]*?)(?::(?!choose\(|cond:|diff\(\)|inverseDiff\(\)|energyIcons|starIcons|plural:|show:|percentMore\(\)|percentLess\(\)))/;
    while (true) {
      const m = t.match(guard);
      if (!m) return t;
      const start = m.index;
      const varName = m[1];
      const restStart = m.index + m[0].length;
      const closeIdx = findMatchingBrace(t, restStart);
      if (closeIdx < 0) return t;
      const inner = t.slice(restStart, closeIdx - 1);
      const parts = splitPipesAtDepth0(inner);
      const val = lookup(varName, vars);
      const trueVal  = parts[0] || '';
      const falseVal = parts[1] || '';
      const result = (val !== null && val !== undefined && val) ? trueVal : falseVal;
      t = t.slice(0, start) + result + t.slice(closeIdx);
    }
  })(text);

  // {Var:percentMore()} → ((val - 1) * 100) as int string
  text = text.replace(/\{(\w+):percentMore\(\)\}/g, (_, n) => {
    const v = lookup(n, vars);
    if (v == null) return '';
    if (typeof v === 'number') return String(Math.trunc((v - 1) * 100));
    return String(v);
  });

  // {Var:percentLess()} → ((1 - val) * 100) as int string
  text = text.replace(/\{(\w+):percentLess\(\)\}/g, (_, n) => {
    const v = lookup(n, vars);
    if (v == null) return '';
    if (typeof v === 'number') return String(Math.trunc((1 - v) * 100));
    return String(v);
  });

  // {Var:diff()} / {Var:inverseDiff()} → value or "X"
  text = text.replace(/\{(\w+):(?:diff|inverseDiff)\(\)\}/g, (_, n) => {
    const v = lookup(n, vars);
    return v != null ? String(v) : 'X';
  });

  // Strip stray "???" rider placeholders
  text = text.trim().replace(/\n\?\?\?$/, '').trim();
  text = text.replace(/^\?\?\?$/gm, '');

  // Bare {Var}
  text = text.replace(/\{(\w+)\}/g, (_, n) => {
    const v = lookup(n, vars);
    if (v != null) return String(v);
    return `[${makeReadable(n)}]`;
  });

  // Anything left in {…} → value-or-placeholder (last-ditch)
  text = text.replace(/\{([^}]+)\}/g, (_, expr) => {
    const n = expr.split(':')[0];
    const v = lookup(n, vars);
    if (v != null) return String(v);
    return `[${makeReadable(n)}]`;
  });

  return text;
}

function evalCond(opStr, val) {
  const m = opStr.match(/^(>=|<=|!=|>|<|==)\s*(\d+)$/);
  if (!m || typeof val !== 'number') return false;
  const op = m[1], threshold = parseInt(m[2], 10);
  switch (op) {
    case '>':  return val >  threshold;
    case '<':  return val <  threshold;
    case '>=': return val >= threshold;
    case '<=': return val <= threshold;
    case '==': return val === threshold;
    case '!=': return val !== threshold;
  }
  return false;
}

function makeReadable(name) {
  // Strip trailing digits but keep CamelCase intact (so [OwnerName] stays one
  // token for the frontend tokenizer — spaces would split it).
  return String(name).replace(/\d+$/, '').trim();
}

// ── extractVarsFromSource ───────────────────────────────────────────────────

function extractVarsFromSource(content) {
  const all = {};
  if (!content) return all;

  // new XxxVar("Name", Nm, …) / new PowerVar<WeakPower>("SappingWeak", 2m)
  for (const m of content.matchAll(/new\s+\w+Var(?:<\w+>)?\(\s*"(\w+)"\s*,\s*(\d+(?:\.\d+)?)m?(?:\s*,\s*[^)]+)?\)/g)) {
    const raw = m[2];
    all[m[1]] = raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10);
  }

  // new IntVar("Name", Nm)
  for (const m of content.matchAll(/new\s+IntVar\(\s*"(\w+)"\s*,\s*(\d+)m?\)/g)) {
    all[m[1]] = parseInt(m[2], 10);
  }

  // new XxxVar(N) — unnamed typed vars (cards). Captures the type as the key.
  for (const m of content.matchAll(/new\s+(\w+)Var\((\d+)m?(?:\s*,\s*[^)]+)?\)/g)) {
    const t = m[1], v = parseInt(m[2], 10);
    if (!(t in all)) all[t] = v;
  }

  // new PowerVar<XxxPower>(Nm)
  for (const m of content.matchAll(/new\s+PowerVar<(\w+?)(?:Power)?>\((\d+)m?\)/g)) {
    let p = m[1];
    if (p.endsWith('Power')) p = p.slice(0, -'Power'.length);
    const v = parseInt(m[2], 10);
    all[`${p}Power`] = v;
    all[p] = v;
  }

  // new DynamicVar("Name", Nm)
  for (const m of content.matchAll(/new\s+DynamicVar\(\s*"(\w+)"\s*,\s*(\d+(?:\.\d+)?)m?\)/g)) {
    const raw = m[2];
    all[m[1]] = raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10);
  }

  // new DynamicVar("Name", PropertyName) backed by `private int _propertyName = N`
  for (const m of content.matchAll(/new\s+DynamicVar\(\s*"(\w+)"\s*,\s*([A-Z]\w+)\)/g)) {
    const name = m[1], prop = m[2];
    if (name in all) continue;
    const fieldName = '_' + prop[0].toLowerCase() + prop.slice(1);
    const fieldRe = new RegExp(`private\\s+int\\s+${escapeRe(fieldName)}\\s*=\\s*(\\d+)`);
    const fm = content.match(fieldRe);
    if (fm) all[name] = parseInt(fm[1], 10);
  }

  // new EnergyVar("Name", N)
  for (const m of content.matchAll(/new\s+EnergyVar\(\s*"(\w+)"\s*,\s*(\d+)\)/g)) {
    all[m[1]] = parseInt(m[2], 10);
  }

  // foo = new IntVar(N)
  for (const m of content.matchAll(/(\w+)\s*=\s*new\s+IntVar\((\d+)\)/g)) {
    all[m[1]] = parseInt(m[2], 10);
  }

  // new CardsVar("Name", N)
  for (const m of content.matchAll(/new\s+CardsVar\(\s*"(\w+)"\s*,\s*(\d+)\)/g)) {
    all[m[1]] = parseInt(m[2], 10);
  }

  // CalculatedDamageVar special case
  if (content.includes('CalculatedDamageVar') && !('CalculatedDamage' in all)) {
    const base = all.CalculationBase ?? 0;
    if (base != null) all.CalculatedDamage = base;
  }

  // new XxxVar(PropertyName, …) backed by `private int _propertyName = N`
  for (const m of content.matchAll(/new\s+(\w+)Var\(([A-Z]\w+)\s*(?:,\s*[^)]+)?\)/g)) {
    const t = m[1], prop = m[2];
    if (t in all || prop === 'ValueProp') continue;
    const fieldName = '_' + prop[0].toLowerCase() + prop.slice(1);
    const fieldRe = new RegExp(`private\\s+int\\s+${escapeRe(fieldName)}\\s*=\\s*(\\d+)`);
    const fm = content.match(fieldRe);
    if (fm) all[t] = parseInt(fm[1], 10);
  }

  // private const int _varName = N;
  for (const m of content.matchAll(/private\s+const\s+int\s+_?(\w+)\s*=\s*(\d+)/g)) {
    if (!(m[1] in all)) all[m[1]] = parseInt(m[2], 10);
  }

  // private static readonly int[] _name = new int[] { N, N, N };
  const arrRe = /(?:static|readonly)\s+(?:.*?)(?:int|decimal)\[\]\s+_?(\w+)\s*=\s*(?:new\s+\w+\[\d*\]\s*\{|new\s*\[\]\s*\{|\{)\s*([\d,\s m]+)\s*\}/g;
  for (const m of content.matchAll(arrRe)) {
    const arrName = m[1];
    const values = m[2].split(',')
      .map(v => v.trim().replace(/m$/, ''))
      .filter(v => /^\d+$/.test(v))
      .map(v => parseInt(v, 10));
    values.forEach((val, i) => { all[`${arrName}_${i}`] = val; });
  }

  return all;
}

module.exports = { resolveDescription, extractVarsFromSource };
