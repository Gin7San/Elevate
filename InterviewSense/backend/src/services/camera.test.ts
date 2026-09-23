import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCameraPresence, cameraMetricsSchema } from './camera.js';

test('cameraMetricsSchema parses valid metrics and rejects out-of-bounds', () => {
  const valid = cameraMetricsSchema.parse({
    eyeContactScore: 85,
    expressionScore: 78,
    postureScore: 90,
    sampledFrames: 45
  });
  assert.equal(valid.eyeContactScore, 85);

  assert.throws(() => {
    cameraMetricsSchema.parse({
      eyeContactScore: 150
    });
  });
});

test('analyzeCameraPresence produces individual and combined camera presence scores', () => {
  const result = analyzeCameraPresence({
    eyeContactScore: 80,
    expressionScore: 70,
    postureScore: 90
  });

  assert.equal(result.eyeContact.score, 80);
  assert.equal(result.expression.score, 70);
  assert.equal(result.posture.score, 90);
  assert.ok(result.presence.score >= 70 && result.presence.score <= 90);
  assert.ok(result.presence.limitations.some((l) => l.includes('not clinical or tamper-proof')));
});
