import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeVoice, voiceMetricsSchema } from './voice.js';

const validMetrics = {
  durationMs: 30_000,
  averageRms: 0.1,
  energyStd: 0.02,
  silenceRatio: 0.1,
  longPauseCount: 1,
  zeroCrossingMean: 0.1,
  zeroCrossingStd: 0.04
};

test('accepts bounded browser voice metrics and returns a bounded score', () => {
  const metrics = voiceMetricsSchema.parse(validMetrics);
  const result = analyzeVoice(metrics);

  assert.equal(result.category, 'VOICE_DELIVERY');
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(Number.isFinite(result.score));
});

test('rejects out-of-range and unknown voice metrics', () => {
  assert.equal(voiceMetricsSchema.safeParse({ ...validMetrics, silenceRatio: 2 }).success, false);
  assert.equal(voiceMetricsSchema.safeParse({ ...validMetrics, injected: true }).success, false);
  assert.equal(voiceMetricsSchema.safeParse({ ...validMetrics, averageRms: Number.NaN }).success, false);
});
