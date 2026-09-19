import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapJsonValue } from './jsonValue.js';

test('passes through plain objects (native engine shape)', () => {
  const object = { metrics: { pauseCount: 3 }, limitations: [] };
  assert.deepEqual(unwrapJsonValue(object), object);
});

test('unwraps driver-adapter wrapped shape', () => {
  const wrapped = { value: '{"metrics":{"pauseCount":3},"limitations":[]}' };
  assert.deepEqual(unwrapJsonValue(wrapped), { metrics: { pauseCount: 3 }, limitations: [] });
});

test('parses string-encoded json objects', () => {
  assert.deepEqual(unwrapJsonValue('{"a":1}'), { a: 1 });
});

test('preserves nulls and non-json strings', () => {
  assert.equal(unwrapJsonValue(null), null);
  assert.equal(unwrapJsonValue(undefined), null);
  assert.equal(unwrapJsonValue('plain text'), 'plain text');
  assert.equal(unwrapJsonValue('123'), '123', 'non-object json stays a string');
  assert.equal(unwrapJsonValue(42), 42);
});

test('does not unwrap legitimate single-key objects whose value is not json', () => {
  const legit = { value: 'not json at all' };
  assert.deepEqual(unwrapJsonValue(legit), legit);
});
