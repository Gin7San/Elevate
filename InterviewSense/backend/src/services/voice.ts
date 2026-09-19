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

/**
 * Scoring targets, tuned against pilot recordings.
 *
 * Calibration protocol (see README): record 20-30 pilot sessions with at
 * least two microphone setups, have 2+ reviewers rate perceived delivery
 * confidence per clip, then adjust these targets so a median competent
 * speaker lands between ~65 and ~80 overall. Values can be overridden at
 * runtime with the VOICE_CALIBRATION_JSON environment variable (validated
 * against calibrationOverrideSchema) so the tuning loop does not need
 * redeploys.
 */
export const VOICE_CALIBRATION_DEFAULTS = {
  rmsTarget: 0.12, // RMS level treated as full energy
  energyStdTarget: 0.08, // energy variation treated as fully inconsistent
  zcrStdTarget: 0.08, // zero-crossing variation treated as full pitch dynamism
  silencePenaltyPerUnit: 100, // linear penalty for silenceRatio in [0,1]
  longPausePenalty: 5, // per long pause counted by the browser
  weights: { energy: 0.35, consistency: 0.2, pitch: 0.2, pause: 0.25 }
} as const;

export type VoiceCalibration = {
  rmsTarget: number;
  energyStdTarget: number;
  zcrStdTarget: number;
  silencePenaltyPerUnit: number;
  longPausePenalty: number;
  weights: { energy: number; consistency: number; pitch: number; pause: number };
};

const calibrationOverrideSchema = z.object({
  rmsTarget: z.number().positive().max(1).optional(),
  energyStdTarget: z.number().positive().max(1).optional(),
  zcrStdTarget: z.number().positive().max(1).optional(),
  silencePenaltyPerUnit: z.number().positive().max(1000).optional(),
  longPausePenalty: z.number().min(0).max(100).optional(),
  weights: z.object({
    energy: z.number().min(0).max(1),
    consistency: z.number().min(0).max(1),
    pitch: z.number().min(0).max(1),
    pause: z.number().min(0).max(1)
  }).strict().optional()
}).strict();

let cachedCalibration: VoiceCalibration | null = null;

export function loadVoiceCalibration(): VoiceCalibration {
  if (cachedCalibration) return cachedCalibration;
  const raw = process.env.VOICE_CALIBRATION_JSON;
  if (!raw?.trim()) {
    cachedCalibration = { ...VOICE_CALIBRATION_DEFAULTS, weights: { ...VOICE_CALIBRATION_DEFAULTS.weights } };
    return cachedCalibration;
  }
  let parsed: z.SafeParseReturnType<z.input<typeof calibrationOverrideSchema>, z.output<typeof calibrationOverrideSchema>>;
  try {
    parsed = calibrationOverrideSchema.safeParse(JSON.parse(raw));
  } catch {
    console.warn('VOICE_CALIBRATION_JSON is not valid JSON; using default voice calibration');
    cachedCalibration = { ...VOICE_CALIBRATION_DEFAULTS, weights: { ...VOICE_CALIBRATION_DEFAULTS.weights } };
    return cachedCalibration;
  }
  if (!parsed.success) {
    console.warn('VOICE_CALIBRATION_JSON is invalid; using default voice calibration', parsed.error.flatten());
    cachedCalibration = { ...VOICE_CALIBRATION_DEFAULTS, weights: { ...VOICE_CALIBRATION_DEFAULTS.weights } };
    return cachedCalibration;
  }
  cachedCalibration = {
    ...VOICE_CALIBRATION_DEFAULTS,
    ...parsed.data,
    weights: { ...VOICE_CALIBRATION_DEFAULTS.weights, ...parsed.data.weights }
  };
  return cachedCalibration;
}

/** Visible for testing: clears the cached environment-derived calibration. */
export function resetVoiceCalibrationCache() {
  cachedCalibration = null;
}

export function analyzeVoice(metrics: VoiceMetrics, calibration: VoiceCalibration = loadVoiceCalibration()) {
  const energyScore = clamp(Math.min(metrics.averageRms / calibration.rmsTarget, 1) * 100);
  const consistencyScore = clamp(100 - Math.min(metrics.energyStd / calibration.energyStdTarget, 1) * 100);
  const pitchVariationScore = clamp(Math.min(metrics.zeroCrossingStd / calibration.zcrStdTarget, 1) * 100);
  const pauseScore = clamp(100 - metrics.silenceRatio * calibration.silencePenaltyPerUnit - metrics.longPauseCount * calibration.longPausePenalty);
  const score = clamp(
    energyScore * calibration.weights.energy
    + consistencyScore * calibration.weights.consistency
    + pitchVariationScore * calibration.weights.pitch
    + pauseScore * calibration.weights.pause
  );

  return {
    category: 'VOICE_DELIVERY', score,
    metrics: { ...metrics, energyScore, consistencyScore, pitchVariationScore, pauseScore, calibrationVersion: '1' },
    limitations: [
      'Volume depends on microphone distance and hardware.',
      'Pitch is estimated using zero-crossing variation in this MVP.',
      'Metrics are calculated in the browser and should not be treated as tamper-proof.',
      `Scoring thresholds are calibration targets (v1) tuned on pilot recordings, not clinically validated cutoffs.`
    ]
  };
}
