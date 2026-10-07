'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  replay,
  digest,
  ReplayError,
  RequestValidationError,
} = require('../src/replay');
const { parseStrict, JsonParseError } = require('../src/jsonparse');

const { fixtures } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'vectors.json'), 'utf8'),
);

describe('replay over independently generated vectors', () => {
  for (const fx of fixtures) {
    test(`${fx.name} => ${fx.status}`, () => {
      if (fx.status === 200) {
        const result = replay(fx.request);
        assert.deepEqual(
          result.revisions.map((r) => r.revisionId),
          fx.expect.revisionIds,
        );
        assert.deepEqual(
          result.revisions.map((r) => r.postHash),
          fx.expect.postHashes,
        );
        assert.equal(result.finalHash, fx.expect.finalHash);
        // Last post-hash equals the final document digest.
        assert.equal(
          result.revisions[result.revisions.length - 1].postHash,
          result.finalHash,
        );
        assert.deepEqual(result.finalDocument, fx.expect.finalDocument);
        // finalHash is truly the RFC 8785 digest of the final document.
        assert.equal(digest(result.finalDocument), result.finalHash);
      } else {
        let err;
        try {
          replay(fx.request);
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof ReplayError, `expected ReplayError, got ${err}`);
        assert.equal(err.statusCode, fx.status);
        assert.equal(err.code, fx.expect.code,
          `code mismatch: ${err.code} vs ${fx.expect.code}\n${err.message}`);
        assert.equal(err.revisionIndex, fx.expect.revisionIndex);
        if (fx.expect.operationIndex !== null && fx.expect.operationIndex !== undefined) {
          assert.equal(err.operationIndex, fx.expect.operationIndex);
        }
        // Every failure must name the revision.
        assert.equal(err.revisionId,
          fx.request.revisions[fx.expect.revisionIndex].revisionId);
      }
    });
  }
});

describe('chain halts at the first failing revision', () => {
  test('later revision is never evaluated and position is exact', () => {
    const { fixtures: fxs } = { fixtures };
    const fx = fxs.find((f) => f.name === 'failed-revision-is-atomic');
    let err;
    try {
      replay(fx.request);
    } catch (e) {
      err = e;
    }
    assert.equal(err.code, 'TEST_ASSERTION_FAILED');
    assert.equal(err.revisionIndex, 1);
    assert.equal(err.operationIndex, 1);
  });
});

describe('request envelope validation', () => {
  const validRevision = {
    revisionId: 'r1',
    preHash: '0'.repeat(64),
    postHash: '0'.repeat(64),
    operations: [{ op: 'test', path: '', value: {} }],
  };
  test('baseline must be an object', () => {
    assert.throws(
      () => replay({ baseline: [1], revisions: [validRevision] }),
      (e) => e instanceof RequestValidationError && e.code === 'BASELINE_NOT_OBJECT',
    );
  });
  test('revision count below 1 rejected', () => {
    assert.throws(
      () => replay({ baseline: {}, revisions: [] }),
      (e) => e.code === 'REVISION_COUNT_OUT_OF_RANGE',
    );
  });
  test('revision count above 64 rejected', () => {
    const revisions = [];
    for (let i = 0; i < 65; i++) {
      revisions.push({ ...validRevision, revisionId: `r${i}` });
    }
    assert.throws(
      () => replay({ baseline: {}, revisions }),
      (e) => e.code === 'REVISION_COUNT_OUT_OF_RANGE',
    );
  });
  test('operation count above 100 rejected', () => {
    const rev = {
      ...validRevision,
      operations: Array.from({ length: 101 }, () => ({
        op: 'test', path: '', value: {},
      })),
    };
    assert.throws(
      () => replay({ baseline: {}, revisions: [rev] }),
      (e) => e.code === 'OPERATION_COUNT_OUT_OF_RANGE',
    );
  });
  test('empty operations rejected', () => {
    const rev = { ...validRevision, operations: [] };
    assert.throws(
      () => replay({ baseline: {}, revisions: [rev] }),
      (e) => e.code === 'OPERATION_COUNT_OUT_OF_RANGE',
    );
  });
  test('duplicate revisionId rejected', () => {
    assert.throws(
      () => replay({
        baseline: {},
        revisions: [
          { ...validRevision, revisionId: 'dup' },
          { ...validRevision, revisionId: 'dup' },
        ],
      }),
      (e) => e.code === 'DUPLICATE_REVISION_ID',
    );
  });
  test('uppercase hash rejected (must be lowercase hex)', () => {
    const rev = { ...validRevision, preHash: 'A'.repeat(64) };
    assert.throws(
      () => replay({ baseline: {}, revisions: [rev] }),
      (e) => e.code === 'INVALID_HASH',
    );
  });
  test('short hash rejected', () => {
    const rev = { ...validRevision, preHash: 'a'.repeat(63) };
    assert.throws(
      () => replay({ baseline: {}, revisions: [rev] }),
      (e) => e.code === 'INVALID_HASH',
    );
  });
});

describe('strict JSON parser', () => {
  test('duplicate property names rejected', () => {
    assert.throws(() => parseStrict('{"a":1,"a":2}'),
      (e) => e instanceof JsonParseError && e.code === 'DUPLICATE_KEY');
  });
  test('nested duplicate property names rejected', () => {
    assert.throws(() => parseStrict('{"x":{"a":1,"a":2}}'),
      (e) => e instanceof JsonParseError && e.code === 'DUPLICATE_KEY');
  });
  test('lone surrogate escape rejected', () => {
    assert.throws(() => parseStrict('"\\uDEAD"'),
      (e) => e instanceof JsonParseError && e.code === 'LONE_SURROGATE');
  });
  test('unpaired high surrogate rejected', () => {
    assert.throws(() => parseStrict('"\\uD800x"'),
      (e) => e instanceof JsonParseError && e.code === 'LONE_SURROGATE');
  });
  test('paired surrogate accepted', () => {
    assert.equal(parseStrict('"\\uD83D\\uDE00"'), '😀');
  });
  test('overflow rejected instead of Infinity', () => {
    assert.throws(() => parseStrict('1e999'),
      (e) => e instanceof JsonParseError && e.code === 'NON_FINITE_NUMBER');
    assert.throws(() => parseStrict('-1e400'),
      (e) => e instanceof JsonParseError && e.code === 'NON_FINITE_NUMBER');
  });
  test('unescaped control character rejected', () => {
    assert.throws(() => parseStrict('"a\n"'.replace('\\n', '\n')),
      (e) => e instanceof JsonParseError);
  });
  test('trailing data rejected', () => {
    assert.throws(() => parseStrict('{} {}'), (e) => e instanceof JsonParseError);
  });
  test('leading-zero number rejected', () => {
    assert.throws(() => parseStrict('01'), (e) => e instanceof JsonParseError);
  });
  test('null prototype: "__proto__" key does not pollute', () => {
    const v = parseStrict('{"__proto__":{"polluted":true}}');
    assert.equal({}.polluted, undefined);
    assert.equal(v.__proto__.polluted, true);
  });
  test('excessive nesting rejected with NESTING_TOO_DEEP', () => {
    const deep = `${'['.repeat(1100)}1${']'.repeat(1100)}`;
    assert.throws(() => parseStrict(deep),
      (e) => e instanceof JsonParseError && e.code === 'NESTING_TOO_DEEP');
  });
  test('nesting at the limit is accepted', () => {
    const atLimit = `${'['.repeat(1000)}1${']'.repeat(1000)}`;
    const v = parseStrict(atLimit);
    assert.ok(Array.isArray(v));
  });
});
