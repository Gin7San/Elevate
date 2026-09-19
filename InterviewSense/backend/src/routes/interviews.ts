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
  // questionId, transcript, durationMs, voiceMetrics, pauseAnalysis + margin
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 6, parts: 8 },
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
  pauseAnalysis: z.string().max(2500).optional()
}).strict();

function questionsForRole(role?: string) {
  const target = role || 'this role';
  return [
    `Tell me about yourself and your experience relevant to ${target}.`,
    `What interests you most about ${target}?`,
    'Describe a difficult problem you solved and how you approached it.',
    'Tell me about a time you received difficult feedback. How did you respond?',
    'What questions would you like to ask the interviewer?'
  ];
}

async function removeUpload(mediaUrl?: string | null) {
  if (!mediaUrl?.startsWith('/uploads/')) return;
  const filename = path.basename(mediaUrl);
  await fs.rm(path.join(uploadsPath, filename), { force: true }).catch(() => undefined);
}

/**
 * Loads a session's questions with their answers and analyses using flat
 * one-level includes plus an in-memory join. Three-level nested includes hit
 * a serialization bug in the early Rust-free Prisma client (6.7.0), and this
 * reads identically under the classic engine while costing at most two extra
 * round-trips for a bounded number of questions per session.
 */
async function loadSessionQuestions(sessionId: string) {
  const questions = await prisma.question.findMany({
    where: { sessionId },
    orderBy: { order: 'asc' },
    include: { answer: true }
  });
  const answers = await prisma.answer.findMany({
    where: { questionId: { in: questions.map((question) => question.id) } },
    include: { analyses: true }
  });
  const byQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  return questions.map(({ answer: _answer, ...question }) => ({
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
  return res.json({ interviews });
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = createInterviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A title of at least 2 characters is required', details: parsed.error.flatten() });
  }
  const interview = await prisma.interviewSession.create({
    data: {
      userId: req.userId,
      title: parsed.data.title,
      role: parsed.data.role,
      questions: {
        create: questionsForRole(parsed.data.role).map((text, index) => ({ text, order: index + 1 }))
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

  const question = await prisma.question.findFirst({
    where: { id: parsed.data.questionId, sessionId: req.params.id, session: { userId: req.userId } },
    include: { answer: { select: { mediaUrl: true } } }
  });
  if (!question) {
    await removeUpload(newMediaUrl);
    return res.status(404).json({ error: 'Question not found' });
  }

  const speechAnalysis = analyzeSpeech(parsed.data.transcript, parsed.data.durationMs, pauseAnalysis);
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

      await tx.analysisResult.deleteMany({
        where: { answerId: answer.id, kind: speechAnalysis.category }
      });
      const analyses = [await tx.analysisResult.create({
        data: { answerId: answer.id, kind: speechAnalysis.category, score: speechAnalysis.score, details: { metrics: speechAnalysis.metrics, limitations: speechAnalysis.limitations } }
      })];

      if (voiceAnalysis) {
        await tx.analysisResult.deleteMany({
          where: { answerId: answer.id, kind: voiceAnalysis.category }
        });
        analyses.push(await tx.analysisResult.create({
          data: { answerId: answer.id, kind: voiceAnalysis.category, score: voiceAnalysis.score, details: { metrics: voiceAnalysis.metrics, limitations: voiceAnalysis.limitations } }
        }));
      }
      return { answer, analyses };
    });

    if (newMediaUrl && question.answer?.mediaUrl && question.answer.mediaUrl !== newMediaUrl) {
      await removeUpload(question.answer.mediaUrl);
    }
    return res.json({
      answer: { ...result.answer, mediaUrl: toSignedMediaUrl(result.answer.mediaUrl) },
      speechAnalysis: { ...speechAnalysis, kind: speechAnalysis.category },
      voiceAnalysis: voiceAnalysis ? { ...voiceAnalysis, kind: voiceAnalysis.category } : null,
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

  const unanswered = questions.filter((question) => !question.answer);
  if (unanswered.length > 0) {
    return res.status(409).json({
      error: 'Answer every question before completing the interview',
      unansweredQuestions: unanswered.length
    });
  }

  const scores: number[] = questions.flatMap((question) =>
    question.answer?.analyses.flatMap((analysis) => analysis.score ?? []) ?? []
  );
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
    : null;

  // Narrative feedback: LLM-generated when configured, deterministic offline
  // summary otherwise (never blocks completing an interview).
  const digest = questions.map((question) => ({
    text: question.text,
    transcript: question.answer?.transcript ?? null,
    analyses: (question.answer?.analyses ?? []).map((analysis) => ({
      kind: analysis.kind,
      score: analysis.score,
      metrics: (analysis.details as { metrics?: Record<string, unknown> } | null)?.metrics ?? null
    }))
  }));
  const reportSummary = await generateReportSummary(digest, overallScore);
  const reportDetails = {
    answeredQuestions: questions.length,
    analysisCount: scores.length,
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

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: { report: true }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  const questions = await loadSessionQuestions(interview.id);
  // Media is private: exchange stored upload paths for short-lived signed URLs.
  const signedQuestions = questions.map((question) => ({
    ...question,
    answer: question.answer
      ? { ...question.answer, mediaUrl: toSignedMediaUrl(question.answer.mediaUrl) }
      : null
  }));
  return res.json({ interview: { ...interview, questions: signedQuestions } });
});

export default router;
