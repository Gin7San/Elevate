import OpenAI, { toFile } from 'openai';
import { z } from 'zod';

export type TimestampedWord = { word: string; start: number; end: number };

const PAUSE_THRESHOLD_SECONDS = 0.5;
const LONG_PAUSE_THRESHOLD_SECONDS = 2;

export type PauseAnalysis = {
  pauseCount: number;
  longPauseCount: number;
  totalPauseMs: number;
  longestPauseMs: number;
  speakingRate: number | null;
  audioDurationMs: number | null;
  timestampedTranscription: true;
};

/** Validated when the SPA echoes server-computed pause analysis with an answer. */
export const pauseAnalysisSchema = z.object({
  pauseCount: z.number().int().min(0).max(5000),
  longPauseCount: z.number().int().min(0).max(1000),
  totalPauseMs: z.number().min(0).max(100 * 60 * 1000),
  longestPauseMs: z.number().min(0).max(100 * 60 * 1000),
  speakingRate: z.number().min(0).max(600).nullable(),
  audioDurationMs: z.number().min(0).max(100 * 60 * 1000).nullable(),
  timestampedTranscription: z.literal(true)
}).strict();

/**
 * Computes pause metrics from Whisper word timestamps. A "pause" is any gap
 * >= 0.5 s between consecutive words (including leading/trailing silence when
 * the total audio duration is known); >= 2 s counts as a long pause.
 */
export function analyzeWordTimestamps(words: TimestampedWord[], audioDurationMs?: number | null): PauseAnalysis {
  let pauseCount = 0;
  let longPauseCount = 0;
  let totalPauseMs = 0;
  let longestPauseMs = 0;

  const gaps: number[] = [];
  for (let index = 1; index < words.length; index++) {
    const gap = words[index].start - words[index - 1].end;
    if (gap >= PAUSE_THRESHOLD_SECONDS) gaps.push(gap);
  }
  if (words.length > 0 && audioDurationMs) {
    if (words[0].start >= PAUSE_THRESHOLD_SECONDS) gaps.push(words[0].start);
    const trailing = audioDurationMs / 1000 - words[words.length - 1].end;
    if (trailing >= PAUSE_THRESHOLD_SECONDS) gaps.push(trailing);
  }

  for (const gap of gaps) {
    pauseCount++;
    totalPauseMs += Math.round(gap * 1000);
    longestPauseMs = Math.max(longestPauseMs, Math.round(gap * 1000));
    if (gap >= LONG_PAUSE_THRESHOLD_SECONDS) longPauseCount++;
  }

  const spokenSpanSeconds = words.length > 1 ? words[words.length - 1].end - words[0].start : 0;
  const speakingRate = spokenSpanSeconds > 0 ? Math.round(words.length / (spokenSpanSeconds / 60)) : null;

  return {
    pauseCount,
    longPauseCount,
    totalPauseMs,
    longestPauseMs,
    speakingRate,
    audioDurationMs: audioDurationMs ?? null,
    timestampedTranscription: true
  };
}

export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Transcribes a recording with Whisper and returns the text plus word-level
 * timestamps, which drive the pause analysis in confidence.ts.
 */
export async function transcribeWithWhisper(file: { buffer: Buffer; name: string; type: string }): Promise<{ transcript: string; pauseAnalysis: PauseAnalysis }> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const uploadable = await toFile(file.buffer, file.name, { type: file.type });
  const transcription = await openai.audio.transcriptions.create({
    file: uploadable,
    model: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word']
  });

  const words: TimestampedWord[] = (transcription.words ?? [])
    .map((word) => ({ word: word.word ?? '', start: word.start ?? 0, end: word.end ?? 0 }))
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end));

  const audioDurationMs = typeof transcription.duration === 'number' && Number.isFinite(transcription.duration)
    ? Math.round(transcription.duration * 1000)
    : null;

  return {
    transcript: transcription.text,
    pauseAnalysis: analyzeWordTimestamps(words, audioDurationMs)
  };
}
