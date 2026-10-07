'use strict';

// RFC 8785 JSON Canonicalization Scheme (JCS).
// Produces canonical UTF-8 bytes; also exposes a hex SHA-256 helper.

const crypto = require('node:crypto');

// Serialize a finite IEEE-754 double per RFC 8785 section 3.2.2.2.
// Strategy: rely on ECMAScript's shortest round-trip Number::toString.
// If it uses plain notation, that string is already JCS-conformant (V8's
// fixed/exponential switch matches the RFC boundaries: exp < -6 or >= 21).
// If it uses E-notation, rebuild it as d[.ddd]E±e with forced sign.
function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError('JCS cannot serialize non-finite number');
  }
  const s = n.toString(); // "-0" prints as "0", already matching JCS
  if (!/[eE]/.test(s)) return s;

  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1];
  const intDigits = m[2];
  const fracDigits = m[3] || '';
  let exp = parseInt(m[4], 10);

  // Significant mantissa digits: strip leading zeros (e.g. "0.1") and
  // trailing zeros, tracking the decimal point to fix up the exponent.
  const all = intDigits + fracDigits;
  let first = 0;
  while (first < all.length && all[first] === '0') first++;
  let last = all.length;
  while (last > first && all[last - 1] === '0') last--;
  const digits = all.slice(first, last);
  exp += intDigits.length - 1 - first;

  let out = sign + digits.charAt(0);
  // RFC 8785: the exponential mantissa MUST contain a '.' with at least
  // one digit on each side ("1e21" -> "1.0E+21", not "1E+21").
  if (digits.length > 1) {
    out += '.' + digits.slice(1);
  } else {
    out += '.0';
  }
  out += 'E' + (exp >= 0 ? '+' : '-') + Math.abs(exp);
  return out;
}

function escapeString(s) {
  // JSON.stringify already uses the JCS-required uppercase hex escapes
  // (\u00XX) for the mandatory control-character escapes; surrogate pairs
  // for astral characters are emitted unescaped by V8 which is also valid.
  return JSON.stringify(s);
}

// Compare two UTF-16 code-unit strings as UTF-8 byte sequences (RFC 8785 3.2.3).
const UTF8 = new TextEncoder();
function compareUTF8(a, b) {
  return Buffer.compare(UTF8.encode(a), UTF8.encode(b));
}

// Sort object member names once, encoding each name a single time instead of
// re-encoding on every comparator invocation.
function sortedKeys(obj) {
  const names = Object.keys(obj);
  const decorated = new Array(names.length);
  for (let i = 0; i < names.length; i++) {
    decorated[i] = [names[i], UTF8.encode(names[i])];
  }
  decorated.sort((x, y) => Buffer.compare(x[1], y[1]));
  return decorated.map((pair) => pair[0]);
}

function canonicalize(value, chunks) {
  if (value === null) {
    chunks.push('null');
    return;
  }
  const t = typeof value;
  if (t === 'string') {
    chunks.push(escapeString(value));
  } else if (t === 'number') {
    chunks.push(serializeNumber(value));
  } else if (t === 'boolean') {
    chunks.push(value ? 'true' : 'false');
  } else if (Array.isArray(value)) {
    chunks.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) chunks.push(',');
      const v = value[i];
      if (v === undefined || typeof v === 'bigint' || typeof v === 'symbol' ||
          (typeof v === 'number' && !Number.isFinite(v))) {
        chunks.push('null'); // absent array element => null, JCS cannot represent the gap
      } else if (typeof v === 'function') {
        chunks.push('null');
      } else {
        canonicalize(v, chunks);
      }
    }
    chunks.push(']');
  } else if (t === 'object') {
    // Objects from our own JSON parser use a null prototype; tolerate plain
    // objects either way while only enumerating own enumerable string keys.
    const keys = sortedKeys(value);
    chunks.push('{');
    let first = true;
    for (const key of keys) {
      const v = value[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' ||
          typeof v === 'bigint') continue;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      if (!first) chunks.push(',');
      first = false;
      chunks.push(escapeString(key), ':');
      canonicalize(v, chunks);
    }
    chunks.push('}');
  } else {
    throw new TypeError('JCS cannot serialize value of type ' + t);
  }
}

// Returns canonical UTF-8 bytes (Buffer).
function canonicalBytes(value) {
  const chunks = [];
  canonicalize(value, chunks);
  return Buffer.from(chunks.join(''), 'utf8');
}

function canonicalString(value) {
  return canonicalBytes(value).toString('utf8');
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

module.exports = { serializeNumber, canonicalBytes, canonicalString, canonicalHash, compareUTF8 };
