'use strict';

// Strict JSON parser: RFC 8259 JSON with rejection of duplicate member names,
// and object instances created with a null prototype so keys such as
// "__proto__", "constructor" and "hasOwnProperty" never touch the prototype
// chain used by the patching engine.

class JSONParseError extends SyntaxError {
  constructor(message, position) {
    super(message + (position !== undefined ? ` (at byte offset ${position})` : ''));
    this.name = 'JSONParseError';
    this.position = position;
  }
}

function parseStrict(input) {
  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (Buffer.isBuffer(input)) {
    // Reject malformed UTF-8 rather than silently substituting U+FFFD, and
    // reject a leading BOM (RFC 8259 implementations must not ignore it).
    if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
      throw new JSONParseError('Unexpected UTF-8 BOM', 0);
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      throw new JSONParseError('Input is not valid UTF-8');
    }
  } else {
    throw new TypeError('parseStrict expects string or Buffer');
  }
  let i = 0;
  const n = text.length;

  function skipWs() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  }

  function parseValue(seenKeys) {
    skipWs();
    if (i >= n) throw new JSONParseError('Unexpected end of input', i);
    const c = text[i];
    if (c === '{') return parseObject(seenKeys);
    if (c === '[') return parseArray(seenKeys);
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    throw new JSONParseError(`Unexpected token '${text[i]}'`, i);
  }

  function parseObject() {
    i++; // {
    const obj = Object.create(null);
    skipWs();
    if (text[i] === '}') { i++; return obj; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw new JSONParseError('Expected string key in object', i);
      const key = parseString();
      if (Object.hasOwn(obj, key)) {
        throw new JSONParseError(`Duplicate key ${JSON.stringify(key)} in object`, i);
      }
      skipWs();
      if (text[i] !== ':') throw new JSONParseError("Expected ':' after object key", i);
      i++;
      const value = parseValue();
      obj[key] = value;
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return obj; }
      throw new JSONParseError("Expected ',' or '}' in object", i);
    }
  }

  function parseArray() {
    i++; // [
    const arr = [];
    skipWs();
    if (text[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return arr; }
      throw new JSONParseError("Expected ',' or ']' in array", i);
    }
  }

  function parseString() {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return out; }
      const code = text.charCodeAt(i);
      if (code === 0x5c) { // backslash
        i++;
        if (i >= n) throw new JSONParseError('Unterminated escape', i);
        const e = text[i];
        switch (e) {
          case '"': out += '"'; i++; break;
          case '\\': out += '\\'; i++; break;
          case '/': out += '/'; i++; break;
          case 'b': out += '\b'; i++; break;
          case 'f': out += '\f'; i++; break;
          case 'n': out += '\n'; i++; break;
          case 'r': out += '\r'; i++; break;
          case 't': out += '\t'; i++; break;
          case 'u': {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new JSONParseError('Invalid \\u escape', i);
            }
            let u = parseInt(hex, 16);
            i += 5;
            if (u >= 0xd800 && u <= 0xdbff) {
              if (text[i] !== '\\' || text[i + 1] !== 'u') {
                throw new JSONParseError('Unpaired UTF-16 surrogate', i);
              }
              const hex2 = text.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex2)) {
                throw new JSONParseError('Invalid surrogate pair escape', i);
              }
              const lo = parseInt(hex2, 16);
              if (lo < 0xdc00 || lo > 0xdfff) {
                throw new JSONParseError('Unpaired UTF-16 surrogate', i);
              }
              u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00);
              i += 6;
            } else if (u >= 0xdc00 && u <= 0xdfff) {
              throw new JSONParseError('Unpaired low surrogate', i);
            }
            out += String.fromCodePoint(u);
            break;
          }
          default:
            throw new JSONParseError(`Invalid escape '\\${e}'`, i);
        }
      } else if (code < 0x20) {
        throw new JSONParseError('Unescaped control character in string', i);
      } else {
        out += c;
        i++;
      }
    }
    throw new JSONParseError('Unterminated string', i);
  }

  function parseNumber() {
    const start = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') {
      i++;
    } else if (text[i] >= '1' && text[i] <= '9') {
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    } else {
      throw new JSONParseError('Invalid number', i);
    }
    if (text[i] === '.') {
      i++;
      if (!(text[i] >= '0' && text[i] <= '9')) throw new JSONParseError('Invalid fraction', i);
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!(text[i] >= '0' && text[i] <= '9')) throw new JSONParseError('Invalid exponent', i);
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    const raw = text.slice(start, i);
    return Number(raw); // IEEE-754 double round-trip
  }

  const value = parseValue();
  skipWs();
  if (i < n) throw new JSONParseError('Trailing data after JSON value', i);
  return value;
}

module.exports = { parseStrict, JSONParseError };
