import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from './transcriptCache.js';

test('stores and returns values before they expire', () => {
  const cache = createTtlCache<string>({ ttlMs: 60_000 });
  cache.set('a', 'first');
  assert.equal(cache.get('a'), 'first');
  assert.equal(cache.size, 1);
});

test('drops entries once the ttl passes', async () => {
  const cache = createTtlCache<string>({ ttlMs: 20 });
  cache.set('a', 'first');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0, 'expired entries are removed on read');
});

test('a non-positive ttl disables caching entirely', () => {
  const cache = createTtlCache<string>({ ttlMs: 0 });
  cache.set('a', 'first');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('evicts the least recently used entry when over capacity', () => {
  const cache = createTtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });
  cache.set('a', '1');
  cache.set('b', '2');
  assert.equal(cache.get('a'), '1', 'touching "a" makes "b" the oldest');
  cache.set('c', '3');
  assert.equal(cache.get('b'), undefined, 'the least recently used entry was evicted');
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('c'), '3');
});

test('overwriting a key refreshes it rather than growing the cache', () => {
  const cache = createTtlCache<string>({ ttlMs: 60_000 });
  cache.set('a', '1');
  cache.set('a', '2');
  assert.equal(cache.get('a'), '2');
  assert.equal(cache.size, 1);
  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
  cache.set('b', '3');
  cache.clear();
  assert.equal(cache.size, 0);
});
