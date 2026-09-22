import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateInterviewQuestions, getOfflineQuestions } from './questions.js';

test('getOfflineQuestions always returns exactly 5 questions', () => {
  const generic = getOfflineQuestions();
  assert.equal(generic.length, 5);

  const swe = getOfflineQuestions('Software Engineer');
  assert.equal(swe.length, 5);
  assert.ok(swe[0].includes('Software Engineer'));

  const pm = getOfflineQuestions('Product Manager');
  assert.equal(pm.length, 5);
});

test('generateInterviewQuestions falls back to offline when OPENAI_API_KEY is not set', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await generateInterviewQuestions('DevOps Engineer');
    assert.equal(result.questions.length, 5);
    assert.equal(result.questionSource, 'offline');
  } finally {
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  }
});
