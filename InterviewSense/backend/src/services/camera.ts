import { z } from 'zod';

function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export const cameraMetricsSchema = z.object({
  durationMs: z.number().int().positive().max(100 * 60 * 1000).optional(),
  faceDetected: z.boolean().optional(),
  eyeContactScore: z.number().finite().min(0).max(100).optional(),
  expressionScore: z.number().finite().min(0).max(100).optional(),
  postureScore: z.number().finite().min(0).max(100).optional(),
  sampledFrames: z.number().int().min(0).optional()
}).strict();

export type CameraMetrics = z.infer<typeof cameraMetricsSchema>;

export const CAMERA_LIMITATIONS = [
  'Presence metrics are camera-derived coaching heuristics, not clinical or tamper-proof assessments.',
  'Camera angle, lighting, and frame rate can influence measured eye contact, posture, and expression.'
];

export function analyzeCameraPresence(metrics: CameraMetrics) {
  const eyeContactScore = metrics.eyeContactScore != null ? clamp(metrics.eyeContactScore) : 75;
  const expressionScore = metrics.expressionScore != null ? clamp(metrics.expressionScore) : 75;
  const postureScore = metrics.postureScore != null ? clamp(metrics.postureScore) : 75;

  const presenceScore = clamp(eyeContactScore * 0.45 + expressionScore * 0.35 + postureScore * 0.20);

  return {
    eyeContact: {
      category: 'CAMERA_EYE_CONTACT' as const,
      score: eyeContactScore,
      metrics: { eyeContactScore, faceDetected: metrics.faceDetected ?? true },
      limitations: CAMERA_LIMITATIONS
    },
    expression: {
      category: 'CAMERA_EXPRESSION' as const,
      score: expressionScore,
      metrics: { expressionScore, faceDetected: metrics.faceDetected ?? true },
      limitations: CAMERA_LIMITATIONS
    },
    posture: {
      category: 'CAMERA_POSTURE' as const,
      score: postureScore,
      metrics: { postureScore, faceDetected: metrics.faceDetected ?? true },
      limitations: CAMERA_LIMITATIONS
    },
    presence: {
      category: 'CAMERA_PRESENCE' as const,
      score: presenceScore,
      metrics: {
        eyeContactScore,
        expressionScore,
        postureScore,
        faceDetected: metrics.faceDetected ?? true,
        sampledFrames: metrics.sampledFrames ?? null
      },
      limitations: CAMERA_LIMITATIONS
    }
  };
}
