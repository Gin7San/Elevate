import { z } from 'zod';

function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export const voiceMetricsSchema = z.object({
  durationMs: z.number().int().positive().max(100 * 60 * 1000),
  averageRms: z.number().finite().min(0).max(1),
  energyStd: z.number().finite().min(0).max(1),
  silenceRatio: z.number().finite().min(0).max(1),
  longPauseCount: z.number().int().min(0).max(1000),
  zeroCrossingMean: z.number().finite().min(0).max(1),
  zeroCrossingStd: z.number().finite().min(0).max(1)
}).strict();

export type VoiceMetrics = z.infer<typeof voiceMetricsSchema>;

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
    limitations: [
      'Volume depends on microphone distance and hardware.',
      'Pitch is estimated using zero-crossing variation in this MVP.',
      'Metrics are calculated in the browser and should not be treated as tamper-proof.'
    ]
  };
}
