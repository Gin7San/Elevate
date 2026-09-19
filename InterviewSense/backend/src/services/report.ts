import OpenAI from 'openai';
import { z } from 'zod';

export type QuestionDigest = {
  text: string;
  transcript: string | null;
  analyses: Array<{
    kind: string;
    score: number | null;
    metrics?: Record<string, unknown> | null;
  }>;
};

export type ReportSummary = {
  summary: string;
  strengths: string[];
  improvements: string[];
  usedLlm: boolean;
};

const llmSummarySchema = z.object({
  summary: z.string().trim().min(10).max(800),
  strengths: z.array(z.string().trim().min(3).max(160)).max(5).default([]),
  improvements: z.array(z.string().trim().min(3).max(160)).max(5).default([])
}).strict();

function clampSentences(text: string, maxSentences: number): string {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g);
  if (!sentences || sentences.length <= maxSentences) return text.replace(/\s+/g, ' ').trim();
  return sentences.slice(0, maxSentences).join(' ').trim();
}

/**
 * Deterministic, offline summary derived from the recorded analyses. This is
 * the fallback when no LLM is configured (and the documented behavior in
 * tests/CI).
 */
export function fallbackSummary(digest: QuestionDigest[], overallScore: number | null): ReportSummary {
  const answered = digest.filter((question) => question.transcript && question.analyses.length > 0);
  const scoreOf = (question: QuestionDigest) => {
    const scores = question.analyses.map((analysis) => analysis.score).filter((score): score is number => score !== null);
    return scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : null;
  };
  const scored = answered
    .map((question, index) => ({ index, score: scoreOf(question) }))
    .filter((question): question is { index: number; score: number } => question.score !== null)
    .sort((a, b) => b.score - a.score);

  const speechMetrics = answered
    .flatMap((question) => question.analyses)
    .find((analysis) => analysis.kind === 'SPEECH_FLUENCY')?.metrics ?? {};
  const fillerRate = typeof speechMetrics.fillerRate === 'number' ? speechMetrics.fillerRate : null;
  const longPauseCount = typeof speechMetrics.longPauseCount === 'number' ? speechMetrics.longPauseCount : null;

  const strengths: string[] = [];
  const improvements: string[] = [];
  if (scored.length > 0) {
    strengths.push(`Strongest answer: Q${scored[0].index + 1} (${Math.round(scored[0].score)}/100).`);
    const weakest = scored[scored.length - 1];
    if (scored.length > 1) improvements.push(`Revisit Q${weakest.index + 1} — it scored lowest (${Math.round(weakest.score)}/100).`);
  }
  if (fillerRate !== null && fillerRate > 3) improvements.push(`Reduce filler words (about ${fillerRate}% of words).`);
  if (longPauseCount !== null && longPauseCount > 0) improvements.push(`Watch for long pauses (${longPauseCount} pause${longPauseCount === 1 ? '' : 's'} over 2s).`);
  if (overallScore !== null && overallScore >= 80) strengths.push('Overall high confidence; keep it up.');

  const summary = [
    `You answered ${answered.length} of ${digest.length} questions${overallScore !== null ? ` with an overall confidence score of ${overallScore}/100` : ''}.`,
    scored.length > 0 ? `Your strongest moment was question ${scored[0].index + 1}.` : '',
    improvements.length > 0 ? 'Focus next on: ' + improvements.join(' ').replace(/\.$/, '').toLowerCase() + '.' : 'Be the first to know: this interview completed cleanly.'
  ].filter(Boolean).join(' ');

  return { summary, strengths, improvements, usedLlm: false };
}

function buildPrompt(digest: QuestionDigest[]): string {
  const perQuestion = digest.map((question, index) => {
    const analyses = question.analyses
      .map((analysis) => `${analysis.kind}: ${analysis.score ?? 'n/a'}/100`)
      .join(', ');
    const excerpt = (question.transcript ?? '').replace(/\s+/g, ' ').slice(0, 280);
    return `Q${index + 1}: ${question.text}\nAnswer excerpt: ${excerpt || '(no transcript)'}\nAnalyses: ${analyses || 'none'}`;
  }).join('\n\n');

  return [
    'You are an interview coach reviewing a mock interview.',
    'Write a JSON object with keys "summary" (2-4 sentences, second person, supportive, concrete),',
    '"strengths" (up to 3 short bullet phrases), and "improvements" (up to 3 short, actionable bullet phrases).',
    'Base every claim only on the transcript excerpts and scores below.',
    '',
    perQuestion
  ].join('\n');
}

/**
 * Produces the narrative report for a completed interview. Uses the configured
 * LLM when OPENAI_API_KEY is present and always falls back to the offline
 * summary on any failure, so completing an interview never breaks.
 */
export async function generateReportSummary(digest: QuestionDigest[], overallScore: number | null): Promise<ReportSummary> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackSummary(digest, overallScore);
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_REPORT_MODEL?.trim() || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 600,
      messages: [{ role: 'user', content: buildPrompt(digest) }]
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Empty completion');
    const parsed = llmSummarySchema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error('Unexpected report shape');
    return {
      summary: clampSentences(parsed.data.summary, 4),
      strengths: parsed.data.strengths,
      improvements: parsed.data.improvements,
      usedLlm: true
    };
  } catch (error) {
    console.error('LLM report generation failed; using offline summary:', error);
    return fallbackSummary(digest, overallScore);
  }
}
