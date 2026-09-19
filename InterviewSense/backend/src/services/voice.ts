function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export type VoiceMetrics = {
  durationMs: number;
  averageRms: number;
  energyStd: number;
  silenceRatio: number;
  longPauseCount: number;
  zeroCrossingMean: number;
  zeroCrossingStd: number;
};

export function analyzeVoice(metrics: VoiceMetrics) {
  // These are MVP heuristics and should be calibrated with pilot recordings.
  const energyScore = clamp(Math.min(metrics.averageRms / 0.12, 1) * 100);
  const consistencyScore = clamp(100 - Math.min(metrics.energyStd / 0.08, 1) * 100);
  const pitchVariationScore = clamp(Math.min(metrics.zeroCrossingStd / 0.08, 1) * 100);
  const pauseScore = clamp(100 - metrics.silenceRatio * 100 - metrics.longPauseCount * 5);
  const score = clamp(energyScore * 0.35 + consistencyScore * 0.20 + pitchVariationScore * 0.20 + pauseScore * 0.25);

  return {
    category: 'VOICE_DELIVERY', score,
    metrics: { ...metrics, energyScore, consistencyScore, pitchVariationScore, pauseScore },
    limitations: ['Volume depends on microphone distance and hardware.', 'Pitch is estimated using zero-crossing variation in this MVP.']
  };
}
