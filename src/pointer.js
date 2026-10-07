'use strict';

// RFC 6901 JSON Pointer parsing and resolution, strict semantics.

class PointerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PointerError';
    this.code = code;
  }
}

// Parse a JSON Pointer string into its array of decoded reference tokens.
// "" denotes the whole document; every non-empty pointer starts with "/".
function parsePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new PointerError('POINTER_SYNTAX', 'JSON Pointer must be a string');
  }
  if (pointer === '') return [];
  if (pointer.charCodeAt(0) !== 0x2f) {
    throw new PointerError('POINTER_SYNTAX', `Non-empty JSON Pointer must start with '/': ${JSON.stringify(pointer)}`);
  }
  const rawTokens = pointer.split('/').slice(1);
  const tokens = new Array(rawTokens.length);
  for (let i = 0; i < rawTokens.length; i++) {
    tokens[i] = decodeToken(rawTokens[i]);
  }
  return tokens;
}

function decodeToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '~') {
      if (token[i + 1] === '0') { out += '~'; i++; }
      else if (token[i + 1] === '1') { out += '/'; i++; }
      else {
        throw new PointerError('POINTER_SYNTAX',
          `Invalid escape '~${token[i + 1] || ''}' in JSON Pointer token`);
      }
    } else {
      out += c;
    }
  }
  return out;
}

// Strict RFC 6902 array reference token test: "0" or digits without leading
// zeroes. Returns the non-negative integer or null when not an array index.
function arrayIndex(token) {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
  const idx = Number(token);
  if (!Number.isSafeInteger(idx)) return null;
  return idx;
}

// Resolve the value at the given (already parsed) pointer.
function get(doc, tokens) {
  let cur = doc;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (Array.isArray(cur)) {
      const idx = arrayIndex(token);
      if (idx === null || idx >= cur.length) {
        throw new PointerError('POINTER_TARGET',
          `Array index '${token}' out of range at token ${i}`);
      }
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.hasOwn(cur, token)) {
        throw new PointerError('POINTER_TARGET',
          `Object member ${JSON.stringify(token)} not found at token ${i}`);
      }
      cur = cur[token];
    } else {
      throw new PointerError('POINTER_TARGET',
        `Cannot dereference token ${JSON.stringify(token)} at level ${i}: container is neither object nor array`);
    }
  }
  return cur;
}

// Resolve the parent container plus the final reference token.
// For the root pointer returns { parent: null, key: null, root: true }.
function resolveParent(doc, tokens) {
  if (tokens.length === 0) return { root: true, parent: null, key: null };
  const parent = get(doc, tokens.slice(0, -1));
  return { root: false, parent, key: tokens[tokens.length - 1] };
}

module.exports = { parsePointer, decodeToken, arrayIndex, get, resolveParent, PointerError };
