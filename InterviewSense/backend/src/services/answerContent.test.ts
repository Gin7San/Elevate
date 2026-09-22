import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAnswerContent, analyzeAnswerContentOffline } from './answerContent.js';

test('analyzeAnswerContentOffline scores structured responses higher than brief answers', () => {
  const short = analyzeAnswerContentOffline('I don know');
  const structured = analyzeAnswerContentOffline(
    'In my previous role as a software developer, I led the redesign of our core payment service because latencies were high. For example, I implemented a Redis cache which reduced database load by 40% and improved response times significantly. As a result, system stability increased.'
  );

  assert.ok(structured.score > short.score);
  assert.ok(structured.limitations.some((l) => l.includes('Coaching heuristic only, not technical correctness.')));
});

test('analyzeAnswerContent includes coaching heuristic limitation', async () => {
  const result = await analyzeAnswerContent('Tell me about yourself', 'I have 5 years experience as a PM.');
  assert.equal(result.category, 'ANSWER_CONTENT');
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.limitations.some((l) => l.includes('Coaching heuristic only, not technical correctness.')));
});
