'use strict';

// Replay orchestration: validates the request envelope, then walks the
// ordered revisions. Each revision is checked against its pre-image digest,
// applied atomically, and checked against its post-image digest. Any failure
// stops replay immediately; later revisions are never touched.

const { canonicalHash } = require('./jcs');
const { parseStrict, JSONParseError } = require('./parse');
const { applyRevision, PatchError } = require('./patch');

const HEX_SHA256 = /^[0-9a-f]{64}$/;

class ReplayError extends Error {
  constructor(statusCode, code, message, location) {
    super(message);
    this.name = 'ReplayError';
    this.statusCode = statusCode;
    this.code = code;
    this.location = location || null;
  }
}

function reject(statusCode, code, message, location) {
  throw new ReplayError(statusCode, code, message, location);
}

function parseEnvelope(rawBody) {
  let body;
  try {
    body = parseStrict(rawBody);
  } catch (err) {
    if (err instanceof JSONParseError) {
      reject(400, 'REQ_MALFORMED', `Request body is not valid JSON: ${err.message}`);
    }
    throw err;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    reject(400, 'REQ_MALFORMED', 'Request body must be a JSON object');
  }
  if (!Object.hasOwn(body, 'baseline') || body.baseline === null ||
      typeof body.baseline !== 'object' || Array.isArray(body.baseline)) {
    reject(400, 'REQ_MALFORMED', "'baseline' must be a JSON object");
  }
  if (!Array.isArray(body.revisions)) {
    reject(400, 'REQ_MALFORMED', "'revisions' must be an array");
  }
  const { revisions } = body;
  if (revisions.length < 1 || revisions.length > 64) {
    reject(400, 'REQ_OUT_OF_RANGE',
      `'revisions' must contain between 1 and 64 entries, got ${revisions.length}`);
  }
  revisions.forEach(validateRevisionShape);
  return body;
}

function validateRevisionShape(rev, index) {
  const loc = { revisionIndex: index };
  if (rev === null || typeof rev !== 'object' || Array.isArray(rev)) {
    reject(400, 'REQ_MALFORMED', `revisions[${index}] must be a JSON object`, loc);
  }
  if (typeof rev.revisionId !== 'string' || rev.revisionId.length === 0) {
    reject(400, 'REQ_MALFORMED',
      `revisions[${index}].revisionId must be a non-empty string`, loc);
  }
  if (typeof rev.beforeHash !== 'string') {
    reject(400, 'REQ_MALFORMED',
      `revisions[${index}].beforeHash must be a string`, loc);
  }
  if (typeof rev.afterHash !== 'string') {
    reject(400, 'REQ_MALFORMED',
      `revisions[${index}].afterHash must be a string`, loc);
  }
  if (!Array.isArray(rev.operations)) {
    reject(400, 'REQ_MALFORMED',
      `revisions[${index}].operations must be an array`, loc);
  }
  if (rev.operations.length < 1 || rev.operations.length > 100) {
    reject(400, 'REQ_OUT_OF_RANGE',
      `revisions[${index}].operations must contain between 1 and 100 operations, got ${rev.operations.length}`,
      loc);
  }
  rev.operations.forEach((op, opIndex) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      reject(400, 'REQ_MALFORMED',
        `revisions[${index}].operations[${opIndex}] must be a JSON object`,
        { revisionIndex: index, operationIndex: opIndex });
    }
  });
}

// Run replay. `rawBody` may be a Buffer (recommended) or a string.
function replay(rawBody) {
  const body = parseEnvelope(rawBody);

  // Uniquely identify revisions before any mutation.
  const seenIds = new Set();
  body.revisions.forEach((rev, index) => {
    if (seenIds.has(rev.revisionId)) {
      reject(422, 'REVISION_ID_DUPLICATE',
        `revisionId ${JSON.stringify(rev.revisionId)} is not unique`,
        { revisionIndex: index, revisionId: rev.revisionId });
    }
    seenIds.add(rev.revisionId);
  });

  let doc = body.baseline;
  const results = [];

  for (let r = 0; r < body.revisions.length; r++) {
    const rev = body.revisions[r];
    const loc = { revisionIndex: r, revisionId: rev.revisionId };

    if (!HEX_SHA256.test(rev.beforeHash)) {
      reject(422, 'HASH_FORMAT',
        `beforeHash must be 64 lowercase hex characters (SHA-256)`, loc);
    }
    if (!HEX_SHA256.test(rev.afterHash)) {
      reject(422, 'HASH_FORMAT',
        `afterHash must be 64 lowercase hex characters (SHA-256)`, loc);
    }

    const beforeHash = canonicalHash(doc);
    if (beforeHash !== rev.beforeHash) {
      reject(422, 'HASH_BEFORE_MISMATCH',
        `Pre-image digest mismatch: document ${beforeHash} does not match declared beforeHash ${rev.beforeHash}`,
        loc);
    }

    let next;
    try {
      next = applyRevision(doc, rev.operations);
    } catch (err) {
      if (err instanceof PatchError) {
        const opLoc = { ...loc, operationIndex: err.opIndex };
        reject(422, err.code, err.message, opLoc);
      }
      throw err;
    }

    const afterHash = canonicalHash(next);
    if (afterHash !== rev.afterHash) {
      reject(422, 'HASH_AFTER_MISMATCH',
        `Post-image digest mismatch: document ${afterHash} does not match declared afterHash ${rev.afterHash}`,
        loc);
    }

    results.push({
      revisionId: rev.revisionId,
      beforeHash,
      afterHash,
    });
    doc = next;
  }

  return {
    revisions: results,
    finalDocument: doc,
    finalHash: canonicalHash(doc),
  };
}

module.exports = { replay, ReplayError, parseEnvelope };
