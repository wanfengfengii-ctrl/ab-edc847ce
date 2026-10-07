'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePointer,
  resolve,
  PointerError,
} = require('../src/pointer');

describe('parsePointer', () => {
  test('root pointer', () => {
    assert.deepEqual(parsePointer(''), []);
  });
  test('simple tokens', () => {
    assert.deepEqual(parsePointer('/a/b'), ['a', 'b']);
  });
  test('empty segments', () => {
    assert.deepEqual(parsePointer('/'), ['']);
    assert.deepEqual(parsePointer('/a/'), ['a', '']);
  });
  test('escape ordering ~1 before ~0 (RFC 6901 section 4)', () => {
    assert.deepEqual(parsePointer('/~01'), ['~1']);
    assert.deepEqual(parsePointer('/~10'), ['/0']);
    assert.deepEqual(parsePointer('/a~1b'), ['a/b']);
    assert.deepEqual(parsePointer('/k~0v'), ['k~v']);
    assert.deepEqual(parsePointer('/~0~1'), ['~/']);
    assert.deepEqual(parsePointer('/~1~0'), ['/~']);
  });
  test('malformed escapes rejected', () => {
    for (const p of ['/a~2b', '/a~', '/~x', '/x~~']) {
      assert.throws(() => parsePointer(p), (e) =>
        e instanceof PointerError && e.code === 'INVALID_POINTER_SYNTAX');
    }
  });
  test('pointer must start with slash unless empty', () => {
    assert.throws(() => parsePointer('a/b'), (e) =>
      e instanceof PointerError && e.code === 'INVALID_POINTER_SYNTAX');
  });
});

describe('resolve', () => {
  const doc = {
    empty: { '': 7 },
    '/': 9,
    '~1': 10,
    foo: ['all', 'grass', 'cows', 'eat'],
    obj: { 'a/b': 'slash', 'k~v': 'tilde' },
  };

  test('RFC 6902 A.14: /~01 points at member "~1"', () => {
    assert.equal(resolve(doc, parsePointer('/~01')), 10);
  });
  test('escaped slash member', () => {
    assert.equal(resolve(doc, parsePointer('/~1')), 9);
  });
  test('nested escaped keys', () => {
    assert.equal(resolve(doc, parsePointer('/obj/a~1b')), 'slash');
    assert.equal(resolve(doc, parsePointer('/obj/k~0v')), 'tilde');
  });
  test('array indices', () => {
    assert.equal(resolve(doc, parsePointer('/foo/0')), 'all');
    assert.equal(resolve(doc, parsePointer('/foo/3')), 'eat');
  });
  test('empty key navigation', () => {
    assert.deepEqual(resolve(doc, parsePointer('/empty')), { '': 7 });
    assert.equal(resolve(doc, parsePointer('/empty/')), 7);
  });
  test('leading-zero array index rejected', () => {
    assert.throws(() => resolve(doc, parsePointer('/foo/01')), (e) =>
      e instanceof PointerError && e.code === 'INVALID_POINTER_SYNTAX');
    assert.throws(() => resolve(doc, parsePointer('/foo/00')), (e) =>
      e instanceof PointerError && e.code === 'INVALID_POINTER_SYNTAX');
  });
  test('index past end', () => {
    assert.throws(() => resolve(doc, parsePointer('/foo/4')), (e) =>
      e instanceof PointerError && e.code === 'POINTER_TARGET_NOT_FOUND');
  });
  test('"-" never resolves to a concrete value', () => {
    assert.throws(() => resolve(doc, parsePointer('/foo/-')), (e) =>
      e instanceof PointerError && e.code === 'POINTER_TARGET_NOT_FOUND');
  });
  test('missing object member', () => {
    assert.throws(() => resolve(doc, parsePointer('/nope')), (e) =>
      e instanceof PointerError && e.code === 'POINTER_TARGET_NOT_FOUND');
  });
  test('traversal through scalar', () => {
    assert.throws(() => resolve(doc, parsePointer('/~1/x')), (e) =>
      e instanceof PointerError && e.code === 'POINTER_TRAVERSAL_FAILURE');
  });
  test('root resolves to the document itself', () => {
    assert.equal(resolve(doc, parsePointer('')), doc);
  });
});
