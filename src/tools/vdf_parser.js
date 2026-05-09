'use strict';
/**
 * vdf_parser.js — Minimal parser for Valve Data Format (VDF / KeyValues).
 *
 * Parses Steam's `libraryfolders.vdf` and `appmanifest_*.acf` files.
 * Returns a plain JS object: each key maps to either a string value or a
 * nested object. Order of keys is preserved through Object insertion order.
 *
 * Doesn't support: macros, conditionals (`[$WIN64]`), include directives.
 * The Steam files we care about don't use any of those.
 */

// Tokenize: yields { kind: 'string' | 'open' | 'close', value }
function* tokenize(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // comments: //... to end of line
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '{') { yield { kind: 'open' };  i++; continue; }
    if (ch === '}') { yield { kind: 'close' }; i++; continue; }
    if (ch === '"') {
      let s = '';
      i++; // consume opening quote
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          // VDF only really uses \\ and \" inside strings; keep it simple.
          const next = text[i + 1];
          if      (next === '\\') s += '\\';
          else if (next === '"')  s += '"';
          else if (next === 'n')  s += '\n';
          else if (next === 't')  s += '\t';
          else                    s += next;
          i += 2;
        } else {
          s += text[i++];
        }
      }
      if (text[i] !== '"') throw new Error(`vdf: unterminated string near offset ${i}`);
      i++; // consume closing quote
      yield { kind: 'string', value: s };
      continue;
    }
    // bareword (rare in Steam files but tolerate)
    let s = '';
    while (i < n && /\S/.test(text[i]) && text[i] !== '{' && text[i] !== '}') s += text[i++];
    if (s) yield { kind: 'string', value: s };
  }
}

// Parse a single object (already past its key, expecting `{ ... }`).
function parseObject(it) {
  const open = it.next();
  if (open.done || open.value.kind !== 'open') {
    throw new Error('vdf: expected { for object');
  }
  const out = {};
  while (true) {
    const tok = it.next();
    if (tok.done) throw new Error('vdf: unexpected end inside object');
    if (tok.value.kind === 'close') return out;
    if (tok.value.kind !== 'string') throw new Error(`vdf: expected key, got ${tok.value.kind}`);
    const key = tok.value.value;
    const val = it.next();
    if (val.done) throw new Error('vdf: unexpected end after key');
    if (val.value.kind === 'string') {
      out[key] = val.value.value;
    } else if (val.value.kind === 'open') {
      // We just consumed `{`; rewind isn't possible, so parse manually.
      const nested = {};
      while (true) {
        const t2 = it.next();
        if (t2.done) throw new Error('vdf: unexpected end inside nested object');
        if (t2.value.kind === 'close') break;
        if (t2.value.kind !== 'string') throw new Error('vdf: expected key in nested object');
        const nk = t2.value.value;
        const nv = it.next();
        if (nv.done) throw new Error('vdf: unexpected end after nested key');
        if (nv.value.kind === 'string') {
          nested[nk] = nv.value.value;
        } else if (nv.value.kind === 'open') {
          // Recurse via wrapper that re-uses parseObject after re-injecting `{`
          nested[nk] = parseRemainingObject(it);
        } else {
          throw new Error(`vdf: unexpected token ${nv.value.kind} as value`);
        }
      }
      out[key] = nested;
    } else {
      throw new Error(`vdf: unexpected token ${val.value.kind} as value`);
    }
  }
}

// Parse the body of an object whose `{` was already consumed by the caller.
function parseRemainingObject(it) {
  const out = {};
  while (true) {
    const tok = it.next();
    if (tok.done) throw new Error('vdf: unexpected end inside nested object');
    if (tok.value.kind === 'close') return out;
    if (tok.value.kind !== 'string') throw new Error('vdf: expected key in nested object');
    const key = tok.value.value;
    const val = it.next();
    if (val.done) throw new Error('vdf: unexpected end after nested key');
    if (val.value.kind === 'string') {
      out[key] = val.value.value;
    } else if (val.value.kind === 'open') {
      out[key] = parseRemainingObject(it);
    } else {
      throw new Error(`vdf: unexpected token ${val.value.kind} as value`);
    }
  }
}

/**
 * Parse a full VDF/ACF document. Steam files always wrap content in a single
 * top-level `"name" { … }` block — we return that inner object, with the
 * name available on the result via `result._root` if the caller wants it.
 */
function parse(text) {
  const it = tokenize(text);
  const first = it.next();
  if (first.done) return {};
  if (first.value.kind !== 'string') throw new Error('vdf: expected root key');
  const rootName = first.value.value;
  const inner = parseObject(it);
  Object.defineProperty(inner, '_root', { value: rootName, enumerable: false });
  return inner;
}

module.exports = { parse };
