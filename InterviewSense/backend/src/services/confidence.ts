const FILLER_PHRASES = ['um', 'uh', 'erm', 'hmm', 'like', 'you know', 'basically', 'actually', 'sort of', 'kind of'];

function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export function analyzeSpeech(transcript: string, durationMs?: number) {
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

  const durationSeconds = durationMs ? durationMs / 1000 : 0;
  const speakingRate = durationSeconds > 0 ? Math.round(wordCount / (durationSeconds / 60)) : null;
  const fillerRate = wordCount > 0 ? Number(((fillerWordCount / wordCount) * 100).toFixed(2)) : 0;
  const fluencyScore = clamp(100 - fillerRate * 8);
  let paceScore = 60;
  if (speakingRate !== null) {
    if (speakingRate >= 110 && speakingRate <= 160) paceScore = 100;
    else if ((speakingRate >= 90 && speakingRate < 110) || (speakingRate > 160 && speakingRate <= 180)) paceScore = 85;
    else if ((speakingRate >= 75 && speakingRate < 90) || (speakingRate > 180 && speakingRate <= 200)) paceScore = 65;
    else paceScore = 45;
  }

  return {
    category: 'SPEECH_FLUENCY',
    score: clamp(fluencyScore * 0.6 + paceScore * 0.4),
    metrics: { wordCount, durationMs: durationMs ?? null, speakingRate, fillerWordCount, fillerRate, fillerCounts, pauseCount: null, paceScore, fluencyScore },
    limitations: ['Pause count requires timestamped transcription and will be added in a later analysis phase.']
  };
}
