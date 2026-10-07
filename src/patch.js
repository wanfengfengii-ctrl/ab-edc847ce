'use strict';

const {
  PointerError,
  parsePointer,
  isArrayIndexToken,
  isPlainObject,
  resolve,
  resolveParent,
  DASH,
} = require('./pointer');

class PatchError extends Error {
  constructor(code, message, operationIndex = null) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.operationIndex = operationIndex;
  }
}

/**
 * Deep clone that preserves null prototypes. This matters because parsed
 * JSON objects use a null prototype (both per I-JSON parsing discipline and
 * to make a "__proto__" member an ordinary data key); structuredClone would
 * silently reattach Object.prototype and re-enable its __proto__ setter.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: deepClone(value[key]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * Deep equality per RFC 6902 Section 4.6: same JSON type, no coercion.
 * Numbers compare numerically (1 and 1.0, 0 and -0 are equal).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) {
    // typeof null already handled; arrays/objects share 'object'.
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ta = typeof a;
  if (ta === 'number') return a === b;
  if (ta === 'string' || ta === 'boolean') return a === b;
  if (ta === 'object') {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!jsonEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Add a value per RFC 6902 Section 4.1 against a parsed pointer.
 * @param {object} root current document root (mutable wrapper not needed;
 *   root replacement is signaled via return value)
 * @param {string[]} tokens
 * @param {unknown} value
 * @returns {unknown} new root (only changes when targeting the root)
 */
function add(root, tokens, value) {
  if (tokens.length === 0) {
    // Replace the whole document.
    return value;
  }
  const { parent, finalToken } = resolveParent(root, tokens);
  if (Array.isArray(parent)) {
    let idx;
    if (finalToken === DASH) {
      idx = parent.length;
    } else if (isArrayIndexToken(finalToken)) {
      idx = Number(finalToken);
      if (idx > parent.length) {
        throw new PatchError(
          'ARRAY_INDEX_OUT_OF_RANGE',
          `Cannot add at index ${idx}: array has ${parent.length} elements`,
        );
      }
    } else {
      throw new PatchError(
        'INVALID_POINTER_SYNTAX',
        `Token ${JSON.stringify(finalToken)} is not a valid array index`,
      );
    }
    parent.splice(idx, 0, value);
    return root;
  }
  if (isPlainObject(parent)) {
    Object.defineProperty(parent, finalToken, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return root;
  }
  throw new PatchError(
    'POINTER_TRAVERSAL_FAILURE',
    'Add target parent is neither an object nor an array',
  );
}

/**
 * Remove a value per RFC 6902 Section 4.2.
 * @returns {unknown} new root
 */
function remove(root, tokens) {
  if (tokens.length === 0) {
    throw new PatchError(
      'ROOT_CANNOT_BE_REMOVED',
      'Removing the document root would leave no JSON value',
    );
  }
  const { parent, finalToken } = resolveParent(root, tokens);
  if (Array.isArray(parent)) {
    if (finalToken === DASH) {
      // "-" never references an existing element.
      throw new PatchError(
        'POINTER_TARGET_NOT_FOUND',
        'No removable array element at "-"',
      );
    }
    if (!isArrayIndexToken(finalToken)) {
      throw new PatchError(
        'INVALID_POINTER_SYNTAX',
        `Token ${JSON.stringify(finalToken)} is not a valid array index`,
      );
    }
    const idx = Number(finalToken);
    if (idx >= parent.length) {
      throw new PatchError(
        'POINTER_TARGET_NOT_FOUND',
        `Array index ${idx} is out of range (length ${parent.length})`,
      );
    }
    parent.splice(idx, 1);
    return root;
  }
  if (isPlainObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, finalToken)) {
      throw new PatchError(
        'POINTER_TARGET_NOT_FOUND',
        `Object member ${JSON.stringify(finalToken)} does not exist`,
      );
    }
    delete parent[finalToken];
    return root;
  }
  throw new PatchError(
    'POINTER_TRAVERSAL_FAILURE',
    'Remove target parent is neither an object nor an array',
  );
}

/**
 * Replace per RFC 6902 Section 4.3. The target MUST exist. Unlike a
 * remove-then-add sequence on arrays, the element is overwritten in place
 * (no positional shift).
 * @returns {unknown} new root
 */
function replace(root, tokens, value) {
  if (tokens.length === 0) {
    return value;
  }
  const { parent, finalToken } = resolveParent(root, tokens);
  if (Array.isArray(parent)) {
    if (!isArrayIndexToken(finalToken)) {
      throw new PatchError(
        'INVALID_POINTER_SYNTAX',
        `Token ${JSON.stringify(finalToken)} is not a valid array index`,
      );
    }
    const idx = Number(finalToken);
    if (idx >= parent.length) {
      throw new PatchError(
        'POINTER_TARGET_NOT_FOUND',
        `Array index ${idx} is out of range (length ${parent.length})`,
      );
    }
    parent[idx] = value;
    return root;
  }
  if (isPlainObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, finalToken)) {
      throw new PatchError(
        'POINTER_TARGET_NOT_FOUND',
        `Object member ${JSON.stringify(finalToken)} does not exist`,
      );
    }
    Object.defineProperty(parent, finalToken, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return root;
  }
  throw new PatchError(
    'POINTER_TRAVERSAL_FAILURE',
    'Replace target parent is neither an object nor an array',
  );
}

/**
 * Apply a single validated operation. Returns the (possibly replaced) root.
 */
function applyOne(root, op) {
  const pathTokens = parsePointer(op.path);

  switch (op.op) {
    case 'add':
      return add(root, pathTokens, op.value);
    case 'remove':
      return remove(root, pathTokens);
    case 'replace':
      return replace(root, pathTokens, op.value);
    case 'test': {
      const actual = resolve(root, pathTokens);
      if (!jsonEqual(actual, op.value)) {
        throw new PatchError(
          'TEST_ASSERTION_FAILED',
          `Test operation failed: value at ${JSON.stringify(op.path)} ` +
            'differs from expected value',
        );
      }
      return root;
    }
    case 'move':
    case 'copy': {
      const fromTokens = parsePointer(op.from);
      // For "move" only: "from" MUST NOT be a proper prefix of "path".
      // "copy" has no such restriction (RFC 6902 4.4 vs 4.5).
      if (
        op.op === 'move' &&
        fromTokens.length < pathTokens.length &&
        fromTokens.every((t, i) => t === pathTokens[i])
      ) {
        throw new PatchError(
          'MOVE_INTO_DESCENDANT',
          'The "from" location must not be a proper prefix of "path"',
        );
      }
      const taken = resolve(root, fromTokens);
      const value = op.op === 'copy' ? deepClone(taken) : taken;
      let next;
      if (op.op === 'move') {
        next = remove(root, fromTokens);
      } else {
        next = root;
      }
      return add(next, pathTokens, value);
    }
    default:
      throw new PatchError('UNKNOWN_OPERATION', `Unknown operation ${JSON.stringify(op.op)}`);
  }
}

/**
 * Validate operation shape (member presence/types), throwing PatchError.
 * Unknown members are ignored per RFC 6902 Section 4.
 * @param {unknown} rawOp
 */
function validateOperation(rawOp) {
  if (!isPlainObject(rawOp)) {
    throw new PatchError('INVALID_OPERATION', 'Each operation must be a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(rawOp, 'op') || typeof rawOp.op !== 'string') {
    throw new PatchError('INVALID_OPERATION', 'Operation is missing a string "op" member');
  }
  const known = ['add', 'remove', 'replace', 'move', 'copy', 'test'];
  if (!known.includes(rawOp.op)) {
    throw new PatchError('UNKNOWN_OPERATION', `Unknown operation ${JSON.stringify(rawOp.op)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(rawOp, 'path') || typeof rawOp.path !== 'string') {
    throw new PatchError('MISSING_PATH', 'Operation is missing a string "path" member');
  }
  if (rawOp.op === 'add' || rawOp.op === 'replace' || rawOp.op === 'test') {
    if (!Object.prototype.hasOwnProperty.call(rawOp, 'value')) {
      throw new PatchError('MISSING_VALUE', `Operation "${rawOp.op}" requires a "value" member`);
    }
  }
  if (rawOp.op === 'move' || rawOp.op === 'copy') {
    if (!Object.prototype.hasOwnProperty.call(rawOp, 'from') || typeof rawOp.from !== 'string') {
      throw new PatchError('MISSING_FROM', `Operation "${rawOp.op}" requires a string "from" member`);
    }
  }
  return rawOp;
}

/**
 * Apply a full RFC 6902 document atomically. Either every operation takes
 * effect or none do; the input document is never mutated on failure.
 * @param {unknown} doc
 * @param {unknown[]} rawOps
 * @returns {unknown} resulting document
 */
function applyPatch(doc, rawOps) {
  let working = deepClone(doc);
  for (let i = 0; i < rawOps.length; i++) {
    try {
      const op = validateOperation(rawOps[i]);
      working = applyOne(working, op);
    } catch (err) {
      if (err instanceof PatchError) {
        if (err.operationIndex === null) err.operationIndex = i;
        throw err;
      }
      if (err instanceof PointerError) {
        throw new PatchError(err.code, err.message, i);
      }
      throw err;
    }
  }
  return working;
}

module.exports = { applyPatch, jsonEqual, PatchError };
