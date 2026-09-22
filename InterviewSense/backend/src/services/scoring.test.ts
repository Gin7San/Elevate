import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAnswerScores, calculateSessionOverallScore } from './scoring.js';

test('without camera signals, delivery is mean of speech and voice', () => {
  const breakdown = calculateAnswerScores([
    { kind: 'SPEECH_FLUENCY', score: 80 },
    { kind: 'VOICE_DELIVERY', score: 90 }
  ]);

  assert.equal(breakdown.hasCamera, false);
  assert.equal(breakdown.deliveryScore, 85);
  assert.equal(breakdown.contentScore, null);
  assert.equal(breakdown.overallScore, 85);
});

test('with camera signals, delivery uses voice 30 / eye contact 25 / expression 20 / posture 15 / speech 10', () => {
  const breakdown = calculateAnswerScores([
    { kind: 'VOICE_DELIVERY', score: 80 },
    { kind: 'CAMERA_EYE_CONTACT', score: 90 },
    { kind: 'CAMERA_EXPRESSION', score: 70 },
    { kind: 'CAMERA_POSTURE', score: 80 },
    { kind: 'SPEECH_FLUENCY', score: 85 }
  ]);

  // Weighted sum: 80*30 + 90*25 + 70*20 + 80*15 + 85*10 = 2400 + 2250 + 1400 + 1200 + 850 = 8100
  // Total weight = 100
  // Delivery = 81
  assert.equal(breakdown.hasCamera, true);
  assert.equal(breakdown.deliveryScore, 81);
});

test('renormalizes delivery when some camera signals are missing', () => {
  const breakdown = calculateAnswerScores([
    { kind: 'VOICE_DELIVERY', score: 80 },
    { kind: 'CAMERA_EYE_CONTACT', score: 90 },
    { kind: 'SPEECH_FLUENCY', score: 80 }
  ]);

  // Voice(30), Eye contact(25), Speech(10) -> total weight = 65
  // Weighted sum: 80*30 + 90*25 + 80*10 = 2400 + 2250 + 800 = 5450
  // Delivery = 5450 / 65 = 83.846... -> 84
  assert.equal(breakdown.hasCamera, true);
  assert.equal(breakdown.deliveryScore, 84);
});

test('overall is 45% answer quality and 55% delivery when both exist', () => {
  const breakdown = calculateAnswerScores([
    { kind: 'SPEECH_FLUENCY', score: 80 },
    { kind: 'VOICE_DELIVERY', score: 80 },
    { kind: 'ANSWER_CONTENT', score: 100 }
  ]);

  // Delivery = (80 + 80) / 2 = 80
  // Overall = 45% * 100 + 55% * 80 = 45 + 44 = 89
  assert.equal(breakdown.deliveryScore, 80);
  assert.equal(breakdown.contentScore, 100);
  assert.equal(breakdown.overallScore, 89);
});

test('calculateSessionOverallScore computes mean of question overall scores', () => {
  const overall = calculateSessionOverallScore([
    {
      answer: {
        analyses: [
          { kind: 'SPEECH_FLUENCY', score: 80 },
          { kind: 'VOICE_DELIVERY', score: 80 },
          { kind: 'ANSWER_CONTENT', score: 100 }
        ] // overall = 89
      }
    },
    {
      answer: {
        analyses: [
          { kind: 'SPEECH_FLUENCY', score: 60 },
          { kind: 'VOICE_DELIVERY', score: 60 },
          { kind: 'ANSWER_CONTENT', score: 60 }
        ] // overall = 60
      }
    }
  ]);

  assert.equal(overall, 75); // (89 + 60) / 2 = 74.5 -> 75
});
