'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const { canonicalize, CanonicalizeError } = require('../src/jcs');

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'jcs-vectors.json'), 'utf8'),
);

describe('RFC 8785 number serialization (Appendix B bit patterns)', () => {
  for (const v of vectors.numberVectors) {
    test(`${v.hex} -> ${v.expected}`, () => {
      const n = Buffer.from(v.hex, 'hex').readDoubleBE();
      assert.equal(canonicalize(n).toString('utf8'), v.expected);
    });
  }
});

test('random doubles and decimal powers of ten', () => {
  for (const v of vectors.randomNumbers) {
    assert.equal(canonicalize(v.json).toString('utf8'), v.expected);
    // Round-tripping the reference serialization yields the same double.
    assert.equal(JSON.parse(v.expected), v.json);
  }
});

test('canonical sample matches RFC 8785 Sections 3.2.3/3.2.4 byte-for-byte', () => {
  const sample = vectors.canonicalSample;
  const bytes = canonicalize(sample.document);
  assert.equal(bytes.toString('hex'), sample.canonicalUtf8Hex);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    sample.sha256,
  );
});

test('property names sort by UTF-16 code units (Section 3.2.3)', () => {
  const sample = vectors.sortSample;
  const bytes = canonicalize(sample.document);
  assert.equal(bytes.toString('hex'), sample.canonicalUtf8Hex);
  // Verify the published order against the raw canonical text. JSON.parse
  // cannot be used here because V8 reorders integer-like keys on objects.
  const text = bytes.toString('utf8');
  let previous = -1;
  for (const key of sample.expectedKeyOrder) {
    const marker = `${JSON.stringify(key)}:`;
    const pos = text.indexOf(marker, previous + 1);
    assert.ok(pos > previous,
      `key ${JSON.stringify(key)} not encountered in expected order`);
    previous = pos;
  }
});

test('nested objects and arrays keep array order, sort object keys', () => {
  const doc = { z: 1, a: { y: 2, b: 3 }, arr: [3, 1, 2] };
  assert.equal(
    canonicalize(doc).toString('utf8'),
    '{"a":{"b":3,"y":2},"arr":[3,1,2],"z":1}',
  );
});

test('string escapes follow ECMAScript rules', () => {
  assert.equal(canonicalize('\u0000').toString('utf8'), '"\\u0000"');
  assert.equal(canonicalize('\u001f').toString('utf8'), '"\\u001f"');
  assert.equal(canonicalize('\u0020').toString('utf8'), '" "');
  assert.equal(canonicalize('\b\f').toString('utf8'), '"\\b\\f"');
  assert.equal(canonicalize('a/b').toString('utf8'), '"a/b"'); // slash not escaped
  assert.equal(canonicalize('\u20ac\uD83D\uDE00').toString('hex'),
    Buffer.from('"\u20ac\uD83D\uDE00"', 'utf8').toString('hex'));
});

test('lone surrogates are rejected', () => {
  assert.throws(() => canonicalize('a\uDEADb'), (err) =>
    err instanceof CanonicalizeError && err.code === 'LONE_SURROGATE');
  assert.throws(() => canonicalize('\uD800x'), (err) =>
    err instanceof CanonicalizeError && err.code === 'LONE_SURROGATE');
  // Properly paired surrogate pair is accepted.
  assert.equal(canonicalize('😀').toString('utf8'), '"😀"');
});

test('non-finite numbers are rejected', () => {
  assert.throws(() => canonicalize(NaN), (err) =>
    err instanceof CanonicalizeError && err.code === 'NON_FINITE_NUMBER');
  assert.throws(() => canonicalize(Infinity), (err) =>
    err instanceof CanonicalizeError && err.code === 'NON_FINITE_NUMBER');
});
