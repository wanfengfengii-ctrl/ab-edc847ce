'use strict';

// RFC 6902 JSON Patch engine.
// All six operations (add, remove, replace, move, copy, test) are applied to
// a deep clone of the input document; any failure aborts the revision and the
// caller keeps the previous document, giving per-revision atomicity.

const { parsePointer, arrayIndex, get, PointerError } = require('./pointer');

class PatchError extends Error {
  constructor(code, message, opIndex) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.opIndex = opIndex;
  }
}

// Deep clone that preserves null-prototype objects emitted by the strict
// parser (structuredClone would reattach Object.prototype and make later
// "__proto__" assignments dangerous).
function deepClone(value) {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = deepClone(value[i]);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

// RFC 6902 §4.6 deep equality over JSON values (member order insignificant).
function jsonEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== 'object' || tb !== 'object') {
    // numbers, strings, booleans: strict equality of value and JS type
    return ta === tb && a === b;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  }
  return true;
}

function addValue(doc, tokens, value) {
  if (tokens.length === 0) {
    // Adding at the root replaces the whole document (RFC 6902 §4.1).
    return value;
  }
  const parent = get(doc, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value);
    } else {
      const idx = arrayIndex(key);
      if (idx === null) {
        throw new PatchError('PATH_NOT_FOUND', `Cannot add: '${key}' is not a valid array index`);
      }
      if (idx > parent.length) {
        throw new PatchError('INDEX_OUT_OF_RANGE',
          `Cannot add at array index ${idx}: array length is ${parent.length}`);
      }
      parent.splice(idx, 0, value);
    }
  } else if (parent !== null && typeof parent === 'object') {
    parent[key] = value; // null-prototype container: no prototype pollution
  } else {
    throw new PatchError('PATH_NOT_FOUND',
      'Cannot add: parent location is neither object nor array');
  }
  return doc;
}

function removeValue(doc, tokens, opIndex) {
  if (tokens.length === 0) {
    throw new PatchError('OP_INVALID', 'Removing the root of the document is not permitted');
  }
  const parent = get(doc, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    const idx = arrayIndex(key);
    if (idx === null || idx >= parent.length) {
      throw new PatchError('PATH_NOT_FOUND',
        `Cannot remove: array index '${key}' does not exist`);
    }
    parent.splice(idx, 1);
  } else if (parent !== null && typeof parent === 'object') {
    if (!Object.hasOwn(parent, key)) {
      throw new PatchError('PATH_NOT_FOUND',
        `Cannot remove: member ${JSON.stringify(key)} does not exist`);
    }
    delete parent[key];
  } else {
    throw new PatchError('PATH_NOT_FOUND', 'Cannot remove: target location does not exist');
  }
  return doc;
}

function replaceValue(doc, tokens, value) {
  if (tokens.length === 0) return value;
  // Target must already exist.
  get(doc, tokens);
  const parent = get(doc, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    const idx = arrayIndex(key);
    if (idx === null || idx >= parent.length) {
      throw new PatchError('PATH_NOT_FOUND', `Cannot replace: array index '${key}' does not exist`);
    }
    parent[idx] = value;
  } else if (parent !== null && typeof parent === 'object') {
    if (!Object.hasOwn(parent, key)) {
      throw new PatchError('PATH_NOT_FOUND',
        `Cannot replace: member ${JSON.stringify(key)} does not exist`);
    }
    parent[key] = value;
  } else {
    throw new PatchError('PATH_NOT_FOUND', 'Cannot replace: target location does not exist');
  }
  return doc;
}

function pointerTokens(op, field, opIndex) {
  const v = op[field];
  if (typeof v !== 'string') {
    throw new PatchError('OP_INVALID', `Operation '${op.op}' requires a string '${field}'`, opIndex);
  }
  try {
    return parsePointer(v);
  } catch (err) {
    if (err instanceof PointerError) {
      throw new PatchError('PATH_SYNTAX', `${field}: ${err.message}`, opIndex);
    }
    throw err;
  }
}

function validateOp(op, opIndex) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new PatchError('OP_INVALID', 'Patch operation must be a JSON object', opIndex);
  }
  if (typeof op.op !== 'string') {
    throw new PatchError('OP_INVALID', "Operation requires a string 'op'", opIndex);
  }
  if (!['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(op.op)) {
    throw new PatchError('OP_INVALID', `Unknown patch operation '${op.op}'`, opIndex);
  }
  if (typeof op.path !== 'string') {
    throw new PatchError('OP_INVALID', `Operation '${op.op}' requires a string 'path'`, opIndex);
  }
  if ((op.op === 'move' || op.op === 'copy') && typeof op.from !== 'string') {
    throw new PatchError('OP_INVALID', `Operation '${op.op}' requires a string 'from'`, opIndex);
  }
  if (['add', 'replace', 'test'].includes(op.op) && !Object.hasOwn(op, 'value')) {
    throw new PatchError('OP_INVALID', `Operation '${op.op}' requires a 'value' member`, opIndex);
  }
}

function applyOne(doc, op, opIndex) {
  validateOp(op, opIndex);
  const pathTokens = pointerTokens(op, 'path', opIndex);

  switch (op.op) {
    case 'add':
      return addValue(doc, pathTokens, deepClone(op.value));
    case 'remove':
      removeValue(doc, pathTokens, opIndex);
      return doc;
    case 'replace':
      return replaceValue(doc, pathTokens, deepClone(op.value));
    case 'copy': {
      const fromTokens = pointerTokens(op, 'from', opIndex);
      let value;
      try {
        value = get(doc, fromTokens);
      } catch (err) {
        if (err instanceof PointerError) {
          throw new PatchError('PATH_NOT_FOUND', `from: ${err.message}`, opIndex);
        }
        throw err;
      }
      return addValue(doc, pathTokens, deepClone(value));
    }
    case 'move': {
      const fromTokens = pointerTokens(op, 'from', opIndex);
      // Moving a location into one of its own descendants is forbidden.
      if (pathTokens.length > fromTokens.length &&
          fromTokens.every((t, i) => t === pathTokens[i])) {
        throw new PatchError('MOVE_TARGET_ILLEGAL',
          'Cannot move a location into its own descendant', opIndex);
      }
      let value;
      try {
        value = get(doc, fromTokens);
      } catch (err) {
        if (err instanceof PointerError) {
          throw new PatchError('PATH_NOT_FOUND', `from: ${err.message}`, opIndex);
        }
        throw err;
      }
      value = deepClone(value);
      removeValue(doc, fromTokens, opIndex);
      return addValue(doc, pathTokens, value);
    }
    case 'test': {
      let actual;
      try {
        actual = get(doc, pathTokens);
      } catch (err) {
        if (err instanceof PointerError) {
          throw new PatchError('PATH_NOT_FOUND', `test target: ${err.message}`, opIndex);
        }
        throw err;
      }
      if (!jsonEqual(actual, op.value)) {
        throw new PatchError('TEST_FAILED',
          'test operation failed: actual value differs from expected value', opIndex);
      }
      return doc;
    }
    default:
      throw new PatchError('OP_INVALID', `Unknown patch operation '${op.op}'`, opIndex);
  }
}

// Apply a full revision (array of operation objects) atomically.
// Returns the new document on success; throws PatchError on first failure.
function applyRevision(doc, operations) {
  let next = deepClone(doc);
  for (let i = 0; i < operations.length; i++) {
    try {
      next = applyOne(next, operations[i], i);
    } catch (err) {
      if (err instanceof PatchError) {
        if (err.opIndex === undefined) err.opIndex = i;
        throw err;
      }
      if (err instanceof PointerError) {
        // Only pointer *parsing* failures are syntax errors; resolution
        // failures surfacing from add/remove/replace are missing targets.
        const code = err.code === 'POINTER_SYNTAX' ? 'PATH_SYNTAX' : 'PATH_NOT_FOUND';
        throw new PatchError(code, err.message, i);
      }
      throw err;
    }
  }
  return next;
}

module.exports = { applyRevision, deepClone, jsonEqual, PatchError };
