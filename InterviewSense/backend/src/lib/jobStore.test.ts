import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from './jobStore.js';

type Result = { transcript: string };

test('a job starts queued and moves through its states', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000 });
  const job = store.create('user-1');
  assert.equal(job.state, 'queued');
  assert.match(job.id, /^[0-9a-f-]{36}$/);

  store.transition(job.id, { state: 'running' });
  assert.equal(store.get(job.id, 'user-1')?.state, 'running');

  store.transition(job.id, { state: 'completed', result: { transcript: 'hello' } });
  const done = store.get(job.id, 'user-1');
  assert.equal(done?.state, 'completed');
  assert.deepEqual(done?.result, { transcript: 'hello' });
});

test('a failed job carries its error', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000 });
  const job = store.create('user-1');
  store.transition(job.id, { state: 'failed', error: 'upstream exploded' });
  const failed = store.get(job.id, 'user-1');
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.error, 'upstream exploded');
});

test('jobs are scoped to their owner', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000 });
  const job = store.create('user-1');
  assert.equal(store.get(job.id, 'user-2'), undefined, 'another user cannot read the job');
  assert.equal(store.get('not-a-real-id', 'user-1'), undefined);
});

test('pending counts only unfinished jobs', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000 });
  const first = store.create('user-1');
  const second = store.create('user-1');
  assert.equal(store.pending(), 2);
  store.transition(first.id, { state: 'running' });
  assert.equal(store.pending(), 2, 'running still counts as pending');
  store.transition(first.id, { state: 'completed', result: { transcript: 'x' } });
  assert.equal(store.pending(), 1);
  store.transition(second.id, { state: 'failed', error: 'nope' });
  assert.equal(store.pending(), 0);
});

test('expired jobs disappear', async () => {
  const store = createJobStore<Result>({ ttlMs: 20 });
  const job = store.create('user-1');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.size, 1, 'the entry stays in memory until it is swept or read');
  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 0);
  assert.equal(store.get(job.id, 'user-1'), undefined);
});

test('reading an expired job returns nothing', async () => {
  const store = createJobStore<Result>({ ttlMs: 20 });
  const job = store.create('user-1');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.get(job.id, 'user-1'), undefined);
});

test('the job cap evicts finished jobs before unfinished ones', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000, maxJobs: 2 });
  const running = store.create('user-1');
  const firstDone = store.create('user-1');
  store.transition(firstDone.id, { state: 'completed', result: { transcript: 'x' } });
  store.transition(running.id, { state: 'running' });
  store.create('user-1');
  assert.equal(store.size, 2);
  assert.ok(store.get(running.id, 'user-1'), 'the running job survives the cap');
  assert.equal(store.get(firstDone.id, 'user-1'), undefined, 'the finished job was evicted first');
});

test('the job cap keeps the newest jobs', () => {
  const store = createJobStore<Result>({ ttlMs: 60_000, maxJobs: 2 });
  const first = store.create('user-1');
  const second = store.create('user-1');
  const third = store.create('user-1');
  assert.equal(store.size, 2);
  assert.equal(store.get(first.id, 'user-1'), undefined, 'the oldest job was evicted');
  assert.ok(store.get(second.id, 'user-1'));
  assert.ok(store.get(third.id, 'user-1'));
});
