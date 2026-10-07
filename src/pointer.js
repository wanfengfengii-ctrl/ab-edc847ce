'use strict';

/**
 * Strict RFC 6901 JSON Pointer handling.
 *
 * - Escape decoding honors the mandated "~1" before "~0" ordering.
 * - A "~" not followed by "0" or "1" (including a dangling "~") is a
 *   syntax error.
 * - Every non-empty pointer MUST start with "/".
 * - Array index tokens follow the RFC 6901 ABNF: "0" / (DIGIT1-9 *DIGIT);
 *   leading zeros are rejected. "-" is recognized only as the
 *   nonexistent-element-after-last marker.
 */

class PointerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PointerError';
    this.code = code;
  }
}

/**
 * Decode one reference token (after splitting on "/").
 * @param {string} token
 * @returns {string}
 */
function decodeToken(token) {
  // Reject dangling/unknown escapes before any substitution.
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '~' && (token[i + 1] !== '0' && token[i + 1] !== '1')) {
      throw new PointerError(
        'INVALID_POINTER_SYNTAX',
        `Invalid escape sequence in pointer token ${JSON.stringify(token)}`,
      );
    }
  }
  // RFC 6901: "~1" -> "/" first, then "~0" -> "~".
  return token.split('~1').join('/').split('~0').join('~');
}

/**
 * Parse an RFC 6901 pointer string into decoded reference tokens.
 * @param {string} ref
 * @returns {string[]} empty array denotes the whole document
 */
function parsePointer(ref) {
  if (typeof ref !== 'string') {
    throw new PointerError('INVALID_POINTER_SYNTAX', 'Pointer must be a string');
  }
  if (ref === '') return [];
  if (ref[0] !== '/') {
    throw new PointerError(
      'INVALID_POINTER_SYNTAX',
      `Non-root pointer ${JSON.stringify(ref)} must start with "/"`,
    );
  }
  // A leading "/" creates the first empty segment; drop it explicitly.
  return ref.slice(1).split('/').map(decodeToken);
}

const DASH = '-';

/**
 * @param {string} token
 * @returns {boolean}
 */
function isArrayIndexToken(token) {
  return token === '0' || (/^[1-9][0-9]*$/.test(token));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve one reference token against a container.
 * @param {unknown} container
 * @param {string} token decoded token
 * @returns {{value: unknown}}
 */
function step(container, token) {
  if (Array.isArray(container)) {
    if (token === DASH) {
      throw new PointerError(
        'POINTER_TARGET_NOT_FOUND',
        'The "-" token references the nonexistent element after the last one',
      );
    }
    if (!isArrayIndexToken(token)) {
      throw new PointerError(
        'INVALID_POINTER_SYNTAX',
        `Token ${JSON.stringify(token)} is not a valid array index`,
      );
    }
    const idx = Number(token);
    if (idx >= container.length) {
      throw new PointerError(
        'POINTER_TARGET_NOT_FOUND',
        `Array index ${idx} is out of range (length ${container.length})`,
      );
    }
    return { value: container[idx] };
  }
  if (isPlainObject(container)) {
    if (!Object.prototype.hasOwnProperty.call(container, token)) {
      throw new PointerError(
        'POINTER_TARGET_NOT_FOUND',
        `Object member ${JSON.stringify(token)} does not exist`,
      );
    }
    return { value: container[token] };
  }
  throw new PointerError(
    'POINTER_TRAVERSAL_FAILURE',
    'Cannot traverse through a non-container value',
  );
}

/**
 * Resolve a full pointer against a document.
 * @param {unknown} doc
 * @param {string[]} tokens
 * @returns {unknown}
 */
function resolve(doc, tokens) {
  let cur = doc;
  for (const token of tokens) {
    cur = step(cur, token).value;
  }
  return cur;
}

/**
 * Walk every token except the last and return the parent container plus
 * the final token. Root pointers have no parent.
 * @param {unknown} doc
 * @param {string[]} tokens
 * @returns {{parent: unknown, finalToken: string}}
 */
function resolveParent(doc, tokens) {
  let parent = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    parent = step(parent, tokens[i]).value;
  }
  return { parent, finalToken: tokens[tokens.length - 1] };
}

module.exports = {
  PointerError,
  parsePointer,
  isArrayIndexToken,
  isPlainObject,
  resolve,
  resolveParent,
  DASH,
};
