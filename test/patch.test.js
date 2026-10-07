'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { applyPatch, jsonEqual, PatchError } = require('../src/patch');

function expectPatchError(fn, code, opIndex = null) {
  assert.throws(fn, (err) => {
    if (!(err instanceof PatchError)) return false;
    if (err.code !== code) return false;
    return opIndex === null || err.operationIndex === opIndex;
  });
}

describe('RFC 6902 Appendix A worked examples', () => {
  test('A.1 adding an object member', () => {
    assert.deepEqual(
      applyPatch({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }]),
      { baz: 'qux', foo: 'bar' },
    );
  });
  test('A.2 adding an array element shifts later elements', () => {
    assert.deepEqual(
      applyPatch({ foo: ['bar', 'baz'] },
        [{ op: 'add', path: '/foo/1', value: 'qux' }]),
      { foo: ['bar', 'qux', 'baz'] },
    );
  });
  test('A.3 removing an object member', () => {
    assert.deepEqual(
      applyPatch({ baz: 'qux', foo: 'bar' },
        [{ op: 'remove', path: '/baz' }]),
      { foo: 'bar' },
    );
  });
  test('A.4 removing an array element shifts later elements', () => {
    assert.deepEqual(
      applyPatch({ foo: ['bar', 'qux', 'baz'] },
        [{ op: 'remove', path: '/foo/1' }]),
      { foo: ['bar', 'baz'] },
    );
  });
  test('A.5 replacing a value', () => {
    assert.deepEqual(
      applyPatch({ baz: 'qux', foo: 'bar' },
        [{ op: 'replace', path: '/baz', value: 'boo' }]),
      { baz: 'boo', foo: 'bar' },
    );
  });
  test('A.6 moving a value', () => {
    const doc = { foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } };
    assert.deepEqual(
      applyPatch(doc,
        [{ op: 'move', from: '/foo/waldo', path: '/qux/thud' }]),
      { foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' } },
    );
  });
  test('A.7 moving an array element uses index-before-removal semantics', () => {
    assert.deepEqual(
      applyPatch({ foo: ['all', 'grass', 'cows', 'eat'] },
        [{ op: 'move', from: '/foo/1', path: '/foo/3' }]),
      { foo: ['all', 'cows', 'eat', 'grass'] },
    );
  });
  test('A.8 testing a value succeeds', () => {
    const doc = { baz: 'qux', foo: ['a', 2, 'c'] };
    assert.doesNotThrow(() => applyPatch(doc, [
      { op: 'test', path: '/baz', value: 'qux' },
      { op: 'test', path: '/foo/1', value: 2 },
    ]));
  });
  test('A.14 escape ordering: /~01 tests member "~1"', () => {
    assert.doesNotThrow(() =>
      applyPatch({ '/': 9, '~1': 10 },
        [{ op: 'test', path: '/~01', value: 10 }]));
  });
  test('A.15 string and number never compare equal', () => {
    expectPatchError(
      () => applyPatch({ '/': 9, '~1': 10 },
        [{ op: 'test', path: '/~01', value: '10' }]),
      'TEST_ASSERTION_FAILED', 0);
  });
  test('A.16 appending an array value with "-"', () => {
    assert.deepEqual(
      applyPatch({ foo: ['bar'] },
        [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }]),
      { foo: ['bar', ['abc', 'def']] },
    );
  });
  test('A.12 adding to a nonexistent target fails', () => {
    expectPatchError(
      () => applyPatch({ x: { y: 1 } },
        [{ op: 'add', path: '/x/z/w', value: 1 }]),
      'POINTER_TARGET_NOT_FOUND', 0);
  });
});

describe('the six operation types', () => {
  test('add at root replaces the whole document', () => {
    assert.deepEqual(
      applyPatch({ old: true }, [{ op: 'add', path: '', value: [1, 2] }]),
      [1, 2],
    );
  });
  test('replace at root replaces the whole document', () => {
    assert.deepEqual(
      applyPatch({ old: true }, [{ op: 'replace', path: '', value: null }]),
      null,
    );
  });
  test('replace fails when target does not exist', () => {
    expectPatchError(
      () => applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]),
      'POINTER_TARGET_NOT_FOUND', 0);
  });
  test('copy duplicates a referenced value into a sibling', () => {
    assert.deepEqual(
      applyPatch({ a: { deep: { v: 1 } } },
        [{ op: 'copy', from: '/a/deep', path: '/b' }]),
      { a: { deep: { v: 1 } }, b: { v: 1 } },
    );
  });
  test('copy is a deep copy: mutating result leaves source intact', () => {
    const result = applyPatch({ a: [1, 2] },
      [{ op: 'copy', from: '/a', path: '/b' },
       { op: 'add', path: '/b/-', value: 3 }]);
    assert.deepEqual(result, { a: [1, 2], b: [1, 2, 3] });
  });
  test('copy may target a descendant of from', () => {
    assert.deepEqual(
      applyPatch({ a: [1] }, [{ op: 'copy', from: '/a', path: '/a/-' }]),
      { a: [1, [1]] },
    );
  });
  test('move from a proper prefix of path is rejected', () => {
    expectPatchError(
      () => applyPatch({ a: { b: 1 } },
        [{ op: 'move', from: '/a', path: '/a/c' }]),
      'MOVE_INTO_DESCENDANT', 0);
  });
  test('move fails when from is missing', () => {
    expectPatchError(
      () => applyPatch({}, [{ op: 'move', from: '/x', path: '/y' }]),
      'POINTER_TARGET_NOT_FOUND', 0);
  });
  test('add index must not exceed array length', () => {
    expectPatchError(
      () => applyPatch({ a: [1] }, [{ op: 'add', path: '/a/5', value: 9 }]),
      'ARRAY_INDEX_OUT_OF_RANGE', 0);
  });
  test('remove at index equal to length fails', () => {
    expectPatchError(
      () => applyPatch({ a: [1] }, [{ op: 'remove', path: '/a/1' }]),
      'POINTER_TARGET_NOT_FOUND', 0);
  });
  test('unknown operation rejected', () => {
    expectPatchError(
      () => applyPatch({}, [{ op: 'frobnicate', path: '' }]),
      'UNKNOWN_OPERATION', 0);
  });
  test('missing value member rejected', () => {
    expectPatchError(
      () => applyPatch({ a: 1 }, [{ op: 'replace', path: '/a' }]),
      'MISSING_VALUE', 0);
  });
  test('missing from member rejected', () => {
    expectPatchError(
      () => applyPatch({ a: 1 }, [{ op: 'move', path: '/b' }]),
      'MISSING_FROM', 0);
  });
  test('non-object operation rejected', () => {
    expectPatchError(() => applyPatch({}, ['nope']), 'INVALID_OPERATION', 0);
  });
});

describe('RFC 6902 4.6 equality semantics for test', () => {
  const cases = [
    [1, 1.0, true],
    [0, -0, true],
    [1, '1', false],
    [null, false, false],
    [true, 1, false],
    [[1, 2], [1, 2], true],
    [[1, 2], [2, 1], false],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [{ a: 1 }, { a: 2 }, false],
    ['x', 'x', true],
  ];
  for (const [a, b, expected] of cases) {
    test(`${JSON.stringify(a)} vs ${JSON.stringify(b)} => ${expected}`, () => {
      assert.equal(jsonEqual(a, b), expected);
    });
  }
  test('test succeeds against the document root with empty pointer', () => {
    const doc = { a: [1, 2] };
    assert.doesNotThrow(() =>
      applyPatch(doc, [{ op: 'test', path: '', value: { a: [1, 2] } }]));
  });
});

describe('atomicity', () => {
  test('a failing operation rolls back every earlier operation in the patch', () => {
    const doc = { a: [1, 2, 3], marker: 0 };
    const original = JSON.parse(JSON.stringify(doc));
    expectPatchError(
      () => applyPatch(doc, [
        { op: 'add', path: '/marker', value: 1 },
        { op: 'add', path: '/a/-', value: 9 },
        { op: 'test', path: '/a/0', value: 'nope' },
      ]),
      'TEST_ASSERTION_FAILED', 2);
    assert.deepEqual(doc, original);
  });
  test('input document is never mutated even on success', () => {
    const doc = { a: 1 };
    const snapshot = JSON.parse(JSON.stringify(doc));
    const out = applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
    assert.deepEqual(doc, snapshot);
    assert.deepEqual(out, { a: 1, b: 2 });
  });
  test('error carries the zero-based operation index', () => {
    let idx;
    try {
      applyPatch({}, [
        { op: 'test', path: '', value: {} },
        { op: 'remove', path: '/missing' },
      ]);
    } catch (e) {
      idx = e.operationIndex;
    }
    assert.equal(idx, 1);
  });
});

describe('prototype pollution resistance', () => {
  test('"__proto__" is an ordinary member, not the prototype setter', () => {
    const out = applyPatch({}, [
      { op: 'add', path: '/__proto__', value: { polluted: true } },
      { op: 'test', path: '/__proto__/polluted', value: true },
    ]);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(out).sort(), ['__proto__']);
    assert.equal(out.__proto__.polluted, true); // data member access
  });
  test('constructor member handled as plain data', () => {
    const out = applyPatch({}, [{ op: 'add', path: '/constructor', value: 'x' }]);
    assert.equal(out.constructor, 'x');
  });
});
