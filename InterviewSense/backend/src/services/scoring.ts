export type AnalysisScoreItem = {
  kind: string;
  score: number | null;
};

export type AnswerScoreBreakdown = {
  speechScore: number | null;
  voiceScore: number | null;
  eyeContactScore: number | null;
  expressionScore: number | null;
  postureScore: number | null;
  contentScore: number | null;
  deliveryScore: number | null;
  overallScore: number | null;
  hasCamera: boolean;
};

export function calculateAnswerScores(analyses: AnalysisScoreItem[]): AnswerScoreBreakdown {
  let speechScore: number | null = null;
  let voiceScore: number | null = null;
  let eyeContactScore: number | null = null;
  let expressionScore: number | null = null;
  let postureScore: number | null = null;
  let contentScore: number | null = null;

  for (const item of analyses) {
    if (item.score === null || item.score === undefined) continue;
    if (item.kind === 'SPEECH_FLUENCY') speechScore = item.score;
    else if (item.kind === 'VOICE_DELIVERY') voiceScore = item.score;
    else if (item.kind === 'CAMERA_EYE_CONTACT') eyeContactScore = item.score;
    else if (item.kind === 'CAMERA_EXPRESSION') expressionScore = item.score;
    else if (item.kind === 'CAMERA_POSTURE') postureScore = item.score;
    else if (item.kind === 'ANSWER_CONTENT') contentScore = item.score;
    else if (item.kind === 'CAMERA_PRESENCE' && eyeContactScore === null && expressionScore === null && postureScore === null) {
      eyeContactScore = item.score;
      expressionScore = item.score;
      postureScore = item.score;
    }
  }

  const hasCamera = eyeContactScore !== null || expressionScore !== null || postureScore !== null;

  let deliveryScore: number | null = null;

  if (hasCamera) {
    // With camera signals: voice 30 / eye contact 25 / expression 20 / posture 15 / speech 10
    // Renormalized over whatever was measured.
    let totalWeight = 0;
    let weightedSum = 0;

    if (voiceScore !== null) {
      weightedSum += voiceScore * 30;
      totalWeight += 30;
    }
    if (eyeContactScore !== null) {
      weightedSum += eyeContactScore * 25;
      totalWeight += 25;
    }
    if (expressionScore !== null) {
      weightedSum += expressionScore * 20;
      totalWeight += 20;
    }
    if (postureScore !== null) {
      weightedSum += postureScore * 15;
      totalWeight += 15;
    }
    if (speechScore !== null) {
      weightedSum += speechScore * 10;
      totalWeight += 10;
    }

    if (totalWeight > 0) {
      deliveryScore = Math.round(weightedSum / totalWeight);
    }
  } else {
    // Without a camera: the mean of speech and voice.
    const deliveryScores = [speechScore, voiceScore].filter((s): s is number => s !== null);
    if (deliveryScores.length > 0) {
      deliveryScore = Math.round(deliveryScores.reduce((sum, s) => sum + s, 0) / deliveryScores.length);
    }
  }

  let overallScore: number | null = null;
  if (contentScore !== null && deliveryScore !== null) {
    // Overall is 45% answer quality and 55% delivery when both exist.
    overallScore = Math.round(0.45 * contentScore + 0.55 * deliveryScore);
  } else if (deliveryScore !== null) {
    overallScore = Math.round(deliveryScore);
  } else if (contentScore !== null) {
    overallScore = Math.round(contentScore);
  }

  return {
    speechScore,
    voiceScore,
    eyeContactScore,
    expressionScore,
    postureScore,
    contentScore,
    deliveryScore,
    overallScore,
    hasCamera
  };
}

export function calculateSessionOverallScore(
  questions: Array<{ answer?: { analyses: AnalysisScoreItem[] } | null }>
): number | null {
  const scores: number[] = [];
  for (const q of questions) {
    if (!q.answer?.analyses || q.answer.analyses.length === 0) continue;
    const breakdown = calculateAnswerScores(q.answer.analyses);
    if (breakdown.overallScore !== null) {
      scores.push(breakdown.overallScore);
    }
  }
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}
