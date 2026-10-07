'use strict';

const crypto = require('node:crypto');
const { canonicalize, CanonicalizeError } = require('./jcs');
const { applyPatch, PatchError } = require('./patch');
const { PointerError } = require('./pointer');

const HASH_RE = /^[0-9a-f]{64}$/;

class RequestValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

class ReplayError extends Error {
  constructor(code, message, revisionIndex, revisionId, operationIndex = null) {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
    this.statusCode = 422;
    this.revisionIndex = revisionIndex;
    this.revisionId = revisionId;
    this.operationIndex = operationIndex;
  }
}

/**
 * Compute the lowercase hex SHA-256 of the RFC 8785 canonical form.
 * @param {unknown} doc
 * @returns {string}
 */
function digest(doc) {
  return crypto.createHash('sha256').update(canonicalize(doc)).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the request envelope and per-revision structural constraints.
 * Limits mandated by the service contract:
 *   1..64 ordered revisions, 1..100 operations per revision,
 *   revisionId unique, hashes are 64 lowercase hex characters.
 * @param {unknown} body
 */
function validateRequest(body) {
  if (!isObject(body)) {
    throw new RequestValidationError('INVALID_REQUEST', 'Request body must be a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'baseline')) {
    throw new RequestValidationError('MISSING_BASELINE', 'Request is missing a "baseline" member');
  }
  if (!isObject(body.baseline)) {
    throw new RequestValidationError(
      'BASELINE_NOT_OBJECT',
      'The baseline must be a JSON object',
    );
  }
  if (!Array.isArray(body.revisions)) {
    throw new RequestValidationError('MISSING_REVISIONS', 'Request is missing a "revisions" array');
  }
  if (body.revisions.length < 1 || body.revisions.length > 64) {
    throw new RequestValidationError(
      'REVISION_COUNT_OUT_OF_RANGE',
      'revisions must contain between 1 and 64 entries',
    );
  }
  const seenIds = new Set();
  body.revisions.forEach((rev, i) => {
    const where = `revisions[${i}]`;
    if (!isObject(rev)) {
      throw new RequestValidationError('INVALID_REVISION', `${where} must be a JSON object`);
    }
    if (typeof rev.revisionId !== 'string' || rev.revisionId.length === 0) {
      throw new RequestValidationError('INVALID_REVISION_ID', `${where}.revisionId must be a non-empty string`);
    }
    if (seenIds.has(rev.revisionId)) {
      throw new RequestValidationError(
        'DUPLICATE_REVISION_ID',
        `revisionId ${JSON.stringify(rev.revisionId)} is not unique`,
      );
    }
    seenIds.add(rev.revisionId);
    for (const field of ['preHash', 'postHash']) {
      if (typeof rev[field] !== 'string' || !HASH_RE.test(rev[field])) {
        throw new RequestValidationError(
          'INVALID_HASH',
          `${where}.${field} must be 64 lowercase hexadecimal characters`,
        );
      }
    }
    if (!Array.isArray(rev.operations)) {
      throw new RequestValidationError('INVALID_OPERATIONS', `${where}.operations must be an array`);
    }
    if (rev.operations.length < 1 || rev.operations.length > 100) {
      throw new RequestValidationError(
        'OPERATION_COUNT_OUT_OF_RANGE',
        `${where} must contain between 1 and 100 operations`,
      );
    }
  });
}

/**
 * Replay every ordered revision against the baseline.
 *
 * On the first failure (pre-hash, pointer/patch semantics, test assertion,
 * or post-hash) a 422-class ReplayError pinpoints the revision and, when
 * applicable, the zero-based operation index; later revisions are never
 * touched. Successful revisions are applied atomically via deep-copy
 * isolation inside applyPatch.
 *
 * @param {unknown} body parsed request body
 * @returns {{revisions: Array<{revisionId: string, postHash: string}>,
 *            finalDocument: unknown, finalHash: string}}
 */
function replay(body) {
  validateRequest(body);
  let current = body.baseline;
  const results = [];

  for (let i = 0; i < body.revisions.length; i++) {
    const rev = body.revisions[i];
    const id = rev.revisionId;
    let pre;
    try {
      pre = digest(current);
    } catch (err) {
      if (err instanceof CanonicalizeError) {
        throw new ReplayError(err.code, err.message, i, id);
      }
      throw err;
    }
    if (pre !== rev.preHash) {
      throw new ReplayError(
        'PRE_HASH_MISMATCH',
        `Revision ${i} pre-hash does not match the agreed snapshot`,
        i,
        id,
      );
    }

    let next;
    try {
      next = applyPatch(current, rev.operations);
    } catch (err) {
      if (err instanceof PatchError || err instanceof PointerError) {
        throw new ReplayError(
          err.code,
          err.message,
          i,
          id,
          err.operationIndex ?? null,
        );
      }
      if (err instanceof CanonicalizeError) {
        throw new ReplayError(err.code, err.message, i, id);
      }
      throw err;
    }

    let post;
    try {
      post = digest(next);
    } catch (err) {
      if (err instanceof CanonicalizeError) {
        throw new ReplayError(err.code, err.message, i, id);
      }
      throw err;
    }
    if (post !== rev.postHash) {
      throw new ReplayError(
        'POST_HASH_MISMATCH',
        `Revision ${i} post-hash does not match the replay result`,
        i,
        id,
      );
    }

    results.push({ revisionId: id, postHash: post });
    current = next;
  }

  return {
    revisions: results,
    finalDocument: current,
    finalHash: digest(current),
  };
}

module.exports = {
  replay,
  digest,
  validateRequest,
  ReplayError,
  RequestValidationError,
};
