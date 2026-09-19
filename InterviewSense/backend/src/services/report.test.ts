import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackSummary, generateReportSummary, type QuestionDigest } from './report.js';

const digest: QuestionDigest[] = [
  {
    text: 'Tell me about yourself.',
    transcript: 'Um, I am basically a backend engineer who, like, ships things.',
    analyses: [
      { kind: 'SPEECH_FLUENCY', score: 62, metrics: { fillerRate: 12.5, fillerWordCount: 3, longPauseCount: 2 } },
      { kind: 'VOICE_DELIVERY', score: 70, metrics: null }
    ]
  },
  {
    text: 'Describe a difficult problem you solved.',
    transcript: 'I debugged a race condition in our queue consumer.',
    analyses: [
      { kind: 'SPEECH_FLUENCY', score: 91, metrics: { fillerRate: 0.5, fillerWordCount: 0, longPauseCount: 0 } }
    ]
  }
];

test('fallback summary is deterministic and grounded in the analyses', () => {
  const first = generateReportSummary.length; // keep signature reachable
  assert.ok(first >= 0);
  delete process.env.OPENAI_API_KEY;
  return generateReportSummary(digest, 77).then((report) => {
    assert.equal(report.usedLlm, false);
    assert.ok(report.summary.includes('77/100'));
    assert.ok(report.summary.length >= 40);
    assert.ok(report.strengths.length >= 1, 'produces at least one strength');
    assert.ok(report.improvements.some((item) => item.toLowerCase().includes('filler')), 'flags filler usage');
    assert.ok(report.improvements.some((item) => item.toLowerCase().includes('pause')), 'flags long pauses');
    const again = fallbackSummary(digest, 77);
    assert.deepEqual(report, { ...again, usedLlm: false });
  });
});

test('fallback summary handles empty digests', () => {
  const report = fallbackSummary([], null);
  assert.equal(report.usedLlm, false);
  assert.ok(report.summary.includes('0'));
});
