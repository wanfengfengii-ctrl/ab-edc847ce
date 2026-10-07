'use strict';

/**
 * Strict JSON parser for I-JSON input (RFC 7493 / RFC 8785 Section 3.1):
 *  - rejects duplicate property names
 *  - rejects non-finite numbers (overflow to +/-Infinity)
 *  - rejects lone UTF-16 surrogates introduced via \u escapes
 *  - accepts exactly one JSON value (RFC 8259 grammar, no trailing data)
 *
 * Values are produced with ordinary JSON.parse rounding semantics: number
 * substrings that pass the JSON grammar are converted with Number(), i.e.
 * IEEE 754 double precision.
 */

class JsonParseError extends Error {
  constructor(code, message, position) {
    super(message);
    this.name = 'JsonParseError';
    this.code = code;
    this.position = position;
  }
}

const ESCAPES = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Parser {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.n = text.length;
    this.depth = 0;
  }

  static get MAX_DEPTH() {
    // Keeps every downstream recursive walk (canonicalize, pointer
    // traversal, patch clone) comfortably within the call stack.
    return 1000;
  }

  fail(code, message) {
    throw new JsonParseError(code, `${message} (at byte offset ${this.i})`, this.i);
  }

  enter() {
    if (this.depth >= Parser.MAX_DEPTH) {
      this.fail('NESTING_TOO_DEEP', `Nesting exceeds ${Parser.MAX_DEPTH} levels`);
    }
    this.depth++;
  }

  leave() {
    this.depth--;
  }

  ws() {
    while (this.i < this.n) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  parse() {
    this.ws();
    const value = this.value();
    this.ws();
    if (this.i !== this.n) {
      this.fail('MALFORMED_JSON', 'Unexpected trailing data after JSON value');
    }
    return value;
  }

  value() {
    if (this.i >= this.n) this.fail('MALFORMED_JSON', 'Unexpected end of input');
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    this.fail('MALFORMED_JSON', `Unexpected character ${JSON.stringify(c)}`);
  }

  literal(token, value) {
    if (this.s.startsWith(token, this.i)) {
      this.i += token.length;
      return value;
    }
    this.fail('MALFORMED_JSON', 'Invalid literal');
  }

  object() {
    this.i++; // consume {
    this.enter();
    const obj = Object.create(null);
    const keys = new Set();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      this.leave();
      return obj;
    }
    for (;;) {
      if (this.s[this.i] !== '"') {
        this.fail('MALFORMED_JSON', 'Expected string property name');
      }
      const key = this.string();
      if (keys.has(key)) {
        this.fail('DUPLICATE_KEY', `Duplicate property name ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.ws();
      if (this.s[this.i] !== ':') this.fail('MALFORMED_JSON', 'Expected ":"');
      this.i++;
      this.ws();
      obj[key] = this.value();
      this.ws();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        this.ws();
      } else if (sep === '}') {
        this.i++;
        this.leave();
        return obj;
      } else {
        this.fail('MALFORMED_JSON', 'Expected "," or "}"');
      }
    }
  }

  array() {
    this.i++; // consume [
    this.enter();
    const arr = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      this.leave();
      return arr;
    }
    for (;;) {
      arr.push(this.value());
      this.ws();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        this.ws();
      } else if (sep === ']') {
        this.i++;
        this.leave();
        return arr;
      } else {
        this.fail('MALFORMED_JSON', 'Expected "," or "]"');
      }
    }
  }

  string() {
    this.i++; // consume opening quote
    let out = '';
    const s = this.s;
    while (this.i < this.n) {
      const c = s[this.i];
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        this.i++;
        const e = s[this.i];
        if (e === 'u') {
          const hex = s.slice(this.i + 1, this.i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail('MALFORMED_JSON', 'Invalid \\u escape');
          }
          let cu = parseInt(hex, 16);
          this.i += 5;
          if (cu >= 0xd800 && cu <= 0xdbff) {
            // High surrogate must be followed by \uXXXX low surrogate.
            if (s[this.i] === '\\' && s[this.i + 1] === 'u') {
              const hex2 = s.slice(this.i + 2, this.i + 6);
              if (/^[0-9a-fA-F]{4}$/.test(hex2)) {
                const lo = parseInt(hex2, 16);
                if (lo >= 0xdc00 && lo <= 0xdfff) {
                  out += String.fromCharCode(cu, lo);
                  this.i += 6;
                  continue;
                }
              }
            }
            this.fail('LONE_SURROGATE', 'Unpaired high surrogate in string');
          }
          if (cu >= 0xdc00 && cu <= 0xdfff) {
            this.fail('LONE_SURROGATE', 'Unpaired low surrogate in string');
          }
          out += String.fromCharCode(cu);
        } else {
          if (!Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
            this.fail('MALFORMED_JSON', `Invalid escape "\\${e}"`);
          }
          out += ESCAPES[e];
          this.i++;
        }
      } else {
        const cu = s.charCodeAt(this.i);
        if (cu < 0x20) {
          this.fail('MALFORMED_JSON', 'Unescaped control character in string');
        }
        out += c;
        this.i++;
      }
    }
    this.fail('MALFORMED_JSON', 'Unterminated string');
  }

  number() {
    const start = this.i;
    const s = this.s;
    if (s[this.i] === '-') this.i++;
    if (s[this.i] === '0') {
      this.i++;
    } else if (s[this.i] >= '1' && s[this.i] <= '9') {
      while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    } else {
      this.fail('MALFORMED_JSON', 'Invalid number');
    }
    if (s[this.i] === '.') {
      this.i++;
      if (!(s[this.i] >= '0' && s[this.i] <= '9')) {
        this.fail('MALFORMED_JSON', 'Expected fraction digits');
      }
      while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    if (s[this.i] === 'e' || s[this.i] === 'E') {
      this.i++;
      if (s[this.i] === '+' || s[this.i] === '-') this.i++;
      if (!(s[this.i] >= '0' && s[this.i] <= '9')) {
        this.fail('MALFORMED_JSON', 'Expected exponent digits');
      }
      while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    const text = s.slice(start, this.i);
    const value = Number(text);
    if (!Number.isFinite(value)) {
      this.fail('NON_FINITE_NUMBER', `Number ${text} is out of IEEE 754 double range`);
    }
    return value;
  }
}

/**
 * Parse strict JSON text.
 * @param {string} text
 * @returns {unknown}
 */
function parseStrict(text) {
  return new Parser(text).parse();
}

module.exports = { parseStrict, JsonParseError };
