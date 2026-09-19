import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimit.js';

test('allows up to max hits within a window then blocks', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, namespace: 'test-a' });
  assert.equal(limiter.hit('client-1').allowed, true);
  assert.equal(limiter.hit('client-1').allowed, true);
  assert.equal(limiter.hit('client-1').allowed, true);
  const blocked = limiter.hit('client-1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
});

test('tracks keys independently', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, namespace: 'test-b' });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('b').allowed, true);
  assert.equal(limiter.hit('a').allowed, false);
  assert.equal(limiter.hit('b').allowed, false);
});

test('allows again after the window elapses', async () => {
  const limiter = createRateLimiter({ windowMs: 20, max: 1, namespace: 'test-c' });
  assert.equal(limiter.hit('x').allowed, true);
  assert.equal(limiter.hit('x').allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(limiter.hit('x').allowed, true);
});

test('reset clears counters', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, namespace: 'test-d' });
  limiter.hit('y');
  assert.equal(limiter.hit('y').allowed, false);
  limiter.reset();
  assert.equal(limiter.hit('y').allowed, true);
});
