import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSpeech } from './confidence.js';

test('scores clear speech with a healthy pace highly', () => {
  const transcript = Array.from({ length: 130 }, (_, index) => `word${index}`).join(' ');
  const result = analyzeSpeech(transcript, 60_000);

  assert.equal(result.metrics.wordCount, 130);
  assert.equal(result.metrics.speakingRate, 130);
  assert.equal(result.metrics.fillerWordCount, 0);
  assert.equal(result.score, 100);
});

test('detects single- and multi-word filler phrases', () => {
  const result = analyzeSpeech('Um, I actually kind of like this role, you know.', 20_000);

  assert.equal(result.metrics.fillerCounts.um, 1);
  assert.equal(result.metrics.fillerCounts['kind of'], 1);
  assert.equal(result.metrics.fillerCounts['you know'], 1);
  assert.ok(result.metrics.fillerWordCount >= 6);
  assert.ok(result.score >= 0 && result.score <= 100);
});

test('handles a missing duration without producing an invalid score', () => {
  const result = analyzeSpeech('A concise response.');

  assert.equal(result.metrics.speakingRate, null);
  assert.ok(Number.isFinite(result.score));
});
