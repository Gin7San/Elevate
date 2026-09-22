import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { toSignedMediaUrl } from '../lib/mediaSign.js';
import { analyzeSpeech } from '../services/confidence.js';
import { analyzeVoice, voiceMetricsSchema } from '../services/voice.js';
import { pauseAnalysisSchema } from '../services/transcription.js';
import { generateInterviewQuestions } from '../services/questions.js';
import { analyzeAnswerContent } from '../services/answerContent.js';
import { analyzeCameraPresence, cameraMetricsSchema } from '../services/camera.js';
import { calculateAnswerScores, calculateSessionOverallScore } from '../services/scoring.js';
import { generateReportSummary } from '../services/report.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();
const uploadsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
await fs.mkdir(uploadsPath, { recursive: true });

const acceptedMediaTypes = new Set([
  'video/webm', 'video/mp4', 'audio/webm', 'audio/mp4',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg'
]);
const upload = multer({
  dest: uploadsPath,
  // questionId, transcript, durationMs, voiceMetrics, pauseAnalysis, cameraMetrics + margin
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 8, parts: 10 },
  fileFilter: (_req, file, callback) => {
    if (acceptedMediaTypes.has(file.mimetype)) callback(null, true);
    else callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'media'));
  }
});

const optionalRole = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(2).max(80).optional()
);
const createInterviewSchema = z.object({
  title: z.string().trim().min(2).max(120),
  role: optionalRole
}).strict();
const answerSchema = z.object({
  questionId: z.string().min(1),
  transcript: z.string().trim().min(1).max(10000),
  durationMs: z.number().int().positive().max(100 * 60 * 1000).optional(),
  voiceMetrics: z.string().max(4000).optional(),
  pauseAnalysis: z.string().max(2500).optional(),
  cameraMetrics: z.string().max(4000).optional()
}).strict();

async function removeUpload(mediaUrl?: string | null) {
  if (!mediaUrl?.startsWith('/uploads/')) return;
  const filename = path.basename(mediaUrl);
  await fs.rm(path.join(uploadsPath, filename), { force: true }).catch(() => undefined);
}

/**
 * Loads a session's questions with their answers and analyses using flat
 * one-level includes plus an in-memory join.
 */
async function loadSessionQuestions(sessionId: string) {
  const questions = await prisma.question.findMany({
    where: { sessionId },
    orderBy: { order: 'asc' },
    include: { answer: true }
  });
  const answers = await prisma.answer.findMany({
    where: { questionId: { in: questions.map((question: any) => question.id) } },
    include: { analyses: true }
  });
  const byQuestionId = new Map(answers.map((answer: any) => [answer.questionId, answer]));
  return questions.map(({ answer: _answer, ...question }: any) => ({
    ...question,
    answer: byQuestionId.get(question.id) ?? null
  }));
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interviews = await prisma.interviewSession.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { questions: true } },
      report: { select: { overallScore: true } }
    }
  });
  const questions: Array<{ id: string; sessionId: string }> = interviews.length === 0 ? [] : await prisma.question.findMany({
    where: { sessionId: { in: interviews.map((interview: { id: string }) => interview.id) } },
    select: { id: true, sessionId: true }
  });
  const answers: Array<{ questionId: string; transcript: string | null }> = questions.length === 0 ? [] : await prisma.answer.findMany({
    where: { questionId: { in: questions.map((question) => question.id) } },
    select: { questionId: true, transcript: true }
  });
  const sessionByQuestion = new Map(questions.map((question) => [question.id, question.sessionId]));
  const answeredBySession = new Map<string, number>();
  for (const answer of answers) {
    if (!answer.transcript?.trim()) continue;
    const sessionId = sessionByQuestion.get(answer.questionId);
    if (!sessionId) continue;
    answeredBySession.set(sessionId, (answeredBySession.get(sessionId) ?? 0) + 1);
  }
  return res.json({
    interviews: interviews.map((interview: any) => ({
      ...interview,
      answeredCount: answeredBySession.get(interview.id) ?? 0
    }))
  });
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = createInterviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A title of at least 2 characters is required', details: parsed.error.flatten() });
  }

  const { questions, questionSource } = await generateInterviewQuestions(parsed.data.role);

  const interview = await prisma.interviewSession.create({
    data: {
      userId: req.userId,
      title: parsed.data.title,
      role: parsed.data.role,
      questionSource,
      questions: {
        create: questions.map((text, index) => ({ text, order: index + 1 }))
      }
    },
    include: { questions: { orderBy: { order: 'asc' } } }
  });
  return res.status(201).json({ interview });
});

router.post('/:id/answers', requireAuth, upload.single('media'), async (req: AuthenticatedRequest, res) => {
  const newMediaUrl = req.file ? `/uploads/${req.file.filename}` : undefined;
  if (!req.userId) {
    await removeUpload(newMediaUrl);
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = answerSchema.safeParse({
    ...req.body,
    durationMs: req.body.durationMs ? Number(req.body.durationMs) : undefined
  });
  if (!parsed.success) {
    await removeUpload(newMediaUrl);
    return res.status(400).json({ error: 'A valid, non-empty answer is required', details: parsed.error.flatten() });
  }

  let voiceAnalysis: ReturnType<typeof analyzeVoice> | undefined;
  if (parsed.data.voiceMetrics) {
    try {
      const metrics = voiceMetricsSchema.parse(JSON.parse(parsed.data.voiceMetrics));
      voiceAnalysis = analyzeVoice(metrics);
    } catch {
      await removeUpload(newMediaUrl);
      return res.status(400).json({ error: 'Voice analysis data is invalid' });
    }
  }

  let pauseAnalysis: z.infer<typeof pauseAnalysisSchema> | undefined;
  if (parsed.data.pauseAnalysis) {
    try {
      pauseAnalysis = pauseAnalysisSchema.parse(JSON.parse(parsed.data.pauseAnalysis));
    } catch {
      await removeUpload(newMediaUrl);
      return res.status(400).json({ error: 'Pause analysis data is invalid' });
    }
  }

  let cameraAnalysis: ReturnType<typeof analyzeCameraPresence> | undefined;
  if (parsed.data.cameraMetrics) {
    try {
      const metrics = cameraMetricsSchema.parse(JSON.parse(parsed.data.cameraMetrics));
      cameraAnalysis = analyzeCameraPresence(metrics);
    } catch {
      await removeUpload(newMediaUrl);
      return res.status(400).json({ error: 'Camera analysis data is invalid' });
    }
  }

  const question = await prisma.question.findFirst({
    where: { id: parsed.data.questionId, sessionId: req.params.id, session: { userId: req.userId } },
    include: {
      answer: { select: { mediaUrl: true } },
      session: { select: { role: true } }
    }
  });
  if (!question) {
    await removeUpload(newMediaUrl);
    return res.status(404).json({ error: 'Question not found' });
  }

  const speechAnalysis = analyzeSpeech(parsed.data.transcript, parsed.data.durationMs, pauseAnalysis);
  const answerContentAnalysis = await analyzeAnswerContent(question.text, parsed.data.transcript, question.session?.role ?? undefined);

  try {
    const result = await prisma.$transaction(async (tx: Pick<typeof prisma, 'answer' | 'analysisResult'>) => {
      const answer = await tx.answer.upsert({
        where: { questionId: question.id },
        update: {
          transcript: parsed.data.transcript,
          durationMs: parsed.data.durationMs,
          ...(newMediaUrl ? { mediaUrl: newMediaUrl } : {})
        },
        create: {
          questionId: question.id,
          transcript: parsed.data.transcript,
          durationMs: parsed.data.durationMs,
          mediaUrl: newMediaUrl
        }
      });

      // Clear existing analyses for categories we are updating
      const categoriesToUpdate = [
        speechAnalysis.category,
        answerContentAnalysis.category,
        ...(voiceAnalysis ? [voiceAnalysis.category] : []),
        ...(cameraAnalysis ? [
          cameraAnalysis.eyeContact.category,
          cameraAnalysis.expression.category,
          cameraAnalysis.posture.category,
          cameraAnalysis.presence.category
        ] : [])
      ];

      await tx.analysisResult.deleteMany({
        where: { answerId: answer.id, kind: { in: categoriesToUpdate } }
      });

      const analysesToCreate = [
        { answerId: answer.id, kind: speechAnalysis.category, score: speechAnalysis.score, details: { metrics: speechAnalysis.metrics, limitations: speechAnalysis.limitations } },
        { answerId: answer.id, kind: answerContentAnalysis.category, score: answerContentAnalysis.score, details: { metrics: answerContentAnalysis.metrics, limitations: answerContentAnalysis.limitations } },
        ...(voiceAnalysis ? [{ answerId: answer.id, kind: voiceAnalysis.category, score: voiceAnalysis.score, details: { metrics: voiceAnalysis.metrics, limitations: voiceAnalysis.limitations } }] : []),
        ...(cameraAnalysis ? [
          { answerId: answer.id, kind: cameraAnalysis.eyeContact.category, score: cameraAnalysis.eyeContact.score, details: { metrics: cameraAnalysis.eyeContact.metrics, limitations: cameraAnalysis.eyeContact.limitations } },
          { answerId: answer.id, kind: cameraAnalysis.expression.category, score: cameraAnalysis.expression.score, details: { metrics: cameraAnalysis.expression.metrics, limitations: cameraAnalysis.expression.limitations } },
          { answerId: answer.id, kind: cameraAnalysis.posture.category, score: cameraAnalysis.posture.score, details: { metrics: cameraAnalysis.posture.metrics, limitations: cameraAnalysis.posture.limitations } },
          { answerId: answer.id, kind: cameraAnalysis.presence.category, score: cameraAnalysis.presence.score, details: { metrics: cameraAnalysis.presence.metrics, limitations: cameraAnalysis.presence.limitations } }
        ] : [])
      ];

      const createdAnalyses = await Promise.all(
        analysesToCreate.map((data) => tx.analysisResult.create({ data }))
      );

      return { answer, analyses: createdAnalyses };
    });

    if (newMediaUrl && question.answer?.mediaUrl && question.answer.mediaUrl !== newMediaUrl) {
      await removeUpload(question.answer.mediaUrl);
    }

    const scoreBreakdown = calculateAnswerScores(result.analyses.map((a: any) => ({ kind: a.kind, score: a.score })));

    return res.json({
      answer: { ...result.answer, mediaUrl: toSignedMediaUrl(result.answer.mediaUrl) },
      speechAnalysis: { ...speechAnalysis, kind: speechAnalysis.category },
      answerContentAnalysis: { ...answerContentAnalysis, kind: answerContentAnalysis.category },
      voiceAnalysis: voiceAnalysis ? { ...voiceAnalysis, kind: voiceAnalysis.category } : null,
      cameraAnalysis: cameraAnalysis ? cameraAnalysis.presence : null,
      scoreBreakdown,
      analysisIds: result.analyses.map((item: { id: string }) => item.id)
    });
  } catch (error) {
    await removeUpload(newMediaUrl);
    throw error;
  }
});

router.post('/:id/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, userId: req.userId }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  const questions = await loadSessionQuestions(interview.id);

  const unanswered = questions.filter((question: any) => !question.answer);
  if (unanswered.length > 0) {
    return res.status(409).json({
      error: 'Answer every question before completing the interview',
      unansweredQuestions: unanswered.length
    });
  }

  const overallScore = calculateSessionOverallScore(questions);

  // Digest for narrative feedback report
  const digest = questions.map((question: any) => ({
    text: question.text,
    transcript: question.answer?.transcript ?? null,
    analyses: (question.answer?.analyses ?? []).map((analysis: any) => ({
      kind: analysis.kind,
      score: analysis.score,
      metrics: (analysis.details as { metrics?: Record<string, unknown> } | null)?.metrics ?? null
    }))
  }));
  const reportSummary = await generateReportSummary(digest, overallScore);
  const reportDetails = {
    answeredQuestions: questions.length,
    analysisCount: questions.reduce((acc: number, q: any) => acc + (q.answer?.analyses?.length ?? 0), 0),
    strengths: reportSummary.strengths,
    improvements: reportSummary.improvements,
    usedLlm: reportSummary.usedLlm
  };

  const { completed, report } = await prisma.$transaction(async (tx: Pick<typeof prisma, 'interviewSession' | 'feedbackReport'>) => {
    const completed = await tx.interviewSession.update({
      where: { id: interview.id },
      data: { status: 'COMPLETED', completedAt: new Date() }
    });
    const report = await tx.feedbackReport.upsert({
      where: { sessionId: interview.id },
      update: { overallScore, summary: reportSummary.summary, details: reportDetails },
      create: { sessionId: interview.id, overallScore, summary: reportSummary.summary, details: reportDetails }
    });
    return { completed, report };
  });

  return res.json({
    interview: completed,
    report,
    answeredQuestions: questions.length,
    totalQuestions: questions.length
  });
});

router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, userId: req.userId },
    select: { id: true }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });

  const questions: Array<{ id: string }> = await prisma.question.findMany({
    where: { sessionId: interview.id },
    select: { id: true }
  });
  const answers: Array<{ mediaUrl: string | null }> = questions.length === 0 ? [] : await prisma.answer.findMany({
    where: { questionId: { in: questions.map((question) => question.id) } },
    select: { mediaUrl: true }
  });
  await prisma.interviewSession.delete({ where: { id: interview.id } });
  await Promise.all(answers.map((answer) => removeUpload(answer.mediaUrl)));
  return res.status(204).end();
});

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: { report: true }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  const questions = await loadSessionQuestions(interview.id);
  // Media is private: exchange stored upload paths for short-lived signed URLs.
  const signedQuestions = questions.map((question: any) => ({
    ...question,
    answer: question.answer
      ? { ...question.answer, mediaUrl: toSignedMediaUrl(question.answer.mediaUrl) }
      : null
  }));
  return res.json({ interview: { ...interview, questions: signedQuestions } });
});

export default router;
