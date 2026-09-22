import OpenAI from 'openai';
import { z } from 'zod';

function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

const ACTION_VERBS = [
  'led', 'developed', 'built', 'implemented', 'managed', 'resolved', 'designed',
  'created', 'analyzed', 'improved', 'increased', 'reduced', 'delivered', 'designed',
  'spearheaded', 'orchestrated', 'launched', 'optimized', 'achieved', 'solved'
];

const STRUCTURE_WORDS = [
  'because', 'for example', 'for instance', 'specifically', 'action', 'result',
  'led to', 'learned', 'first', 'then', 'finally', 'outcome', 'impact', 'challenge',
  'situation', 'task', 'goal'
];

export function analyzeAnswerContentOffline(transcript: string) {
  const words = transcript.match(/[\p{L}\p{N}']+/gu) ?? [];
  const wordCount = words.length;
  const normalized = transcript.toLowerCase();

  let lengthScore = 50;
  if (wordCount >= 40 && wordCount <= 250) {
    lengthScore = 95;
  } else if (wordCount > 250 && wordCount <= 400) {
    lengthScore = 80;
  } else if (wordCount >= 15 && wordCount < 40) {
    lengthScore = 65;
  } else if (wordCount < 15) {
    lengthScore = 35;
  } else {
    lengthScore = 70;
  }

  let actionCount = 0;
  for (const verb of ACTION_VERBS) {
    if (new RegExp(`\\b${verb}\\b`, 'i').test(normalized)) actionCount++;
  }

  let structureCount = 0;
  for (const word of STRUCTURE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(normalized)) structureCount++;
  }

  const actionBonus = Math.min(20, actionCount * 5);
  const structureBonus = Math.min(25, structureCount * 5);

  const score = clamp(lengthScore * 0.6 + actionBonus + structureBonus);

  return {
    category: 'ANSWER_CONTENT' as const,
    score,
    metrics: {
      wordCount,
      actionWordCount: actionCount,
      structureMarkerCount: structureCount,
      lengthScore,
      evaluatedOffline: true
    },
    limitations: [
      'Coaching heuristic only, not technical correctness.',
      'Offline heuristic evaluates structural indicators and answer length.'
    ]
  };
}

const llmAnswerContentSchema = z.object({
  score: z.number().finite().min(0).max(100),
  feedback: z.string().trim().min(5).max(500).optional(),
  strengths: z.array(z.string().trim().min(3).max(160)).max(3).optional(),
  improvements: z.array(z.string().trim().min(3).max(160)).max(3).optional()
}).strict();

export async function analyzeAnswerContent(
  questionText: string,
  transcript: string,
  role?: string
) {
  const offlineResult = analyzeAnswerContentOffline(transcript);

  if (!process.env.OPENAI_API_KEY) {
    return offlineResult;
  }

  const model = process.env.OPENAI_ANSWER_MODEL?.trim()
    || process.env.OPENAI_REPORT_MODEL?.trim()
    || 'gpt-4o-mini';

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: [
          `You are an interview coach evaluating an answer for a candidate applying for: "${role || 'General Position'}".`,
          `Question: "${questionText}"`,
          `Candidate Answer Transcript: "${transcript}"`,
          '',
          'Evaluate answer content as a coaching heuristic (clarity, structure, STAR framework, conciseness, concrete examples). Do NOT assess technical correctness or domain truth.',
          'Return a JSON object with keys:',
          '- "score": integer 0-100',
          '- "feedback": brief 1-2 sentence coaching overview',
          '- "strengths": array of up to 2 short phrases',
          '- "improvements": array of up to 2 short, actionable coaching suggestions'
        ].join('\n')
      }]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Empty completion from OpenAI');

    const parsed = llmAnswerContentSchema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error('Invalid answer content analysis JSON');

    return {
      category: 'ANSWER_CONTENT' as const,
      score: clamp(parsed.data.score),
      metrics: {
        wordCount: offlineResult.metrics.wordCount,
        feedback: parsed.data.feedback ?? null,
        strengths: parsed.data.strengths ?? [],
        improvements: parsed.data.improvements ?? [],
        evaluatedOffline: false
      },
      limitations: [
        'Coaching heuristic only, not technical correctness.'
      ]
    };
  } catch (error) {
    console.error('LLM answer content analysis failed; using offline heuristic:', error);
    return offlineResult;
  }
}
