import type { PauseAnalysis } from './transcription.js';

const FILLER_PHRASES = ['um', 'uh', 'erm', 'hmm', 'like', 'you know', 'basically', 'actually', 'sort of', 'kind of'];

// Pause scoring: up to ~5 pauses/minute is natural; long pauses (>=2s)
// hurt perceived fluency the most. Calibrated against pilot interviews;
// see README's analysis section.
const PAUSES_PER_MINUTE_ALLOWANCE = 5;
const PAUSE_DENSITY_PENALTY = 4;
const LONG_PAUSE_PENALTY = 6;

function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export function analyzeSpeech(transcript: string, durationMs?: number, pauseAnalysis?: PauseAnalysis) {
  const normalized = transcript.toLowerCase();
  const words = transcript.match(/[\p{L}\p{N}']+/gu) ?? [];
  const wordCount = words.length;
  const fillerCounts = Object.fromEntries(FILLER_PHRASES.map((phrase) => [phrase, 0]));
  let fillerWordCount = 0;

  for (const phrase of FILLER_PHRASES) {
    const pattern = new RegExp(`\\b${phrase.replace(' ', '\\s+')}\\b`, 'gi');
    const count = normalized.match(pattern)?.length ?? 0;
    fillerCounts[phrase] = count;
    fillerWordCount += phrase.split(' ').length * count;
  }

  // Prefer transcription-derived timing (server-side, word-accurate) and
  // gracefully fall back to the client-provided duration.
  const effectiveDurationMs = pauseAnalysis?.audioDurationMs ?? durationMs;
  const durationSeconds = effectiveDurationMs ? effectiveDurationMs / 1000 : 0;
  const speakingRate = pauseAnalysis?.speakingRate ?? (durationSeconds > 0 ? Math.round(wordCount / (durationSeconds / 60)) : null);
  const fillerRate = wordCount > 0 ? Number(((fillerWordCount / wordCount) * 100).toFixed(2)) : 0;

  let paceScore = 60;
  if (speakingRate !== null) {
    if (speakingRate >= 110 && speakingRate <= 160) paceScore = 100;
    else if ((speakingRate >= 90 && speakingRate < 110) || (speakingRate > 160 && speakingRate <= 180)) paceScore = 85;
    else if ((speakingRate >= 75 && speakingRate < 90) || (speakingRate > 180 && speakingRate <= 200)) paceScore = 65;
    else paceScore = 45;
  }

  const fillerScore = clamp(100 - fillerRate * 8);
  let pauseScore: number | null = null;
  let pausesPerMinute: number | null = null;
  if (pauseAnalysis && durationSeconds > 0) {
    pausesPerMinute = Number((pauseAnalysis.pauseCount / (durationSeconds / 60)).toFixed(2));
    const densityPenalty = Math.max(0, pausesPerMinute - PAUSES_PER_MINUTE_ALLOWANCE) * PAUSE_DENSITY_PENALTY;
    pauseScore = clamp(100 - densityPenalty - pauseAnalysis.longPauseCount * LONG_PAUSE_PENALTY);
  } else if (pauseAnalysis) {
    pauseScore = clamp(100 - pauseAnalysis.longPauseCount * LONG_PAUSE_PENALTY);
  }

  const fluencyScore = pauseScore === null
    ? fillerScore
    : clamp(fillerScore * 0.65 + pauseScore * 0.35);

  const limitations: string[] = [];
  if (!pauseAnalysis) {
    limitations.push('Pause metrics require timestamped transcription; fluent/pace scores here ignore pauses. Attach pauseAnalysis (or enable OPENAI_API_KEY transcription) for the full pipeline.');
  } else if (pauseScore === null) {
    limitations.push('Audio duration unknown; pause density could not be scored, only long pauses were penalized.');
  }

  return {
    category: 'SPEECH_FLUENCY',
    score: clamp(fluencyScore * 0.6 + paceScore * 0.4),
    metrics: {
      wordCount,
      durationMs: effectiveDurationMs ?? null,
      speakingRate,
      fillerWordCount,
      fillerRate,
      fillerCounts,
      fillerScore,
      paceScore,
      pauseCount: pauseAnalysis?.pauseCount ?? null,
      longPauseCount: pauseAnalysis?.longPauseCount ?? null,
      totalPauseMs: pauseAnalysis?.totalPauseMs ?? null,
      longestPauseMs: pauseAnalysis?.longestPauseMs ?? null,
      pausesPerMinute,
      pauseScore,
      timestampedTranscription: Boolean(pauseAnalysis)
    },
    limitations
  };
}
