import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWordTimestamps, pauseAnalysisSchema } from './transcription.js';

test('counts short pauses as word gaps >= 0.5s', () => {
  const words = [
    { word: 'I', start: 0, end: 0.2 },
    { word: 'built', start: 0.8, end: 1.1 }, // 0.6s gap -> pause
    { word: 'a', start: 1.2, end: 1.3 }, // 0.1s gap -> not a pause
    { word: 'service', start: 1.4, end: 2.0 }
  ];
  const result = analyzeWordTimestamps(words);
  assert.equal(result.pauseCount, 1);
  assert.equal(result.longPauseCount, 0);
  assert.equal(result.longestPauseMs, 600);
  assert.equal(result.totalPauseMs, 600);
});

test('flags long pauses (>= 2s) separately', () => {
  const words = [
    { word: 'So', start: 0, end: 0.3 },
    { word: 'then', start: 2.8, end: 3.1 } // 2.5s gap -> long pause
  ];
  const result = analyzeWordTimestamps(words);
  assert.equal(result.pauseCount, 1);
  assert.equal(result.longPauseCount, 1);
  assert.equal(result.longestPauseMs, 2500);
});

test('includes leading and trailing silence when audio duration is known', () => {
  const words = [
    { word: 'Hello', start: 1.0, end: 1.4 },
    { word: 'there', start: 1.5, end: 1.9 }
  ];
  const result = analyzeWordTimestamps(words, 4000);
  assert.equal(result.pauseCount, 2); // 1.0s lead + 2.1s trail
  assert.equal(result.longPauseCount, 1); // trailing 2.1s
});

test('derives speaking rate from the spoken span', () => {
  const words = [
    { word: 'a', start: 0, end: 0.2 },
    { word: 'b', start: 0.3, end: 0.5 },
    { word: 'c', start: 0.6, end: 0.8 },
    { word: 'd', start: 0.9, end: 1.1 }
  ];
  const result = analyzeWordTimestamps(words, 30000);
  // 4 words over a 1.1s spoken span -> 218 wpm
  assert.equal(result.speakingRate, 218);
});

test('handles empty and single-word transcripts', () => {
  assert.equal(analyzeWordTimestamps([]).pauseCount, 0);
  const single = analyzeWordTimestamps([{ word: 'hi', start: 0, end: 0.2 }]);
  assert.equal(single.pauseCount, 0);
  assert.equal(single.speakingRate, null);
});

test('pauseAnalysisSchema accepts server output and rejects tampering', () => {
  const good = analyzeWordTimestamps([{ word: 'hi', start: 0, end: 0.2 }], 1000);
  assert.equal(pauseAnalysisSchema.safeParse(good).success, true);
  assert.equal(pauseAnalysisSchema.safeParse({ ...good, pauseCount: -1 }).success, false);
  assert.equal(pauseAnalysisSchema.safeParse({ ...good, injected: 'x' }).success, false);
  assert.equal(pauseAnalysisSchema.safeParse({ ...good, timestampedTranscription: false }).success, false);
});
