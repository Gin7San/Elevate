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
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
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
  voiceMetrics: z.string().max(4000).optional()
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

  const question = await prisma.question.findFirst({
    where: { id: parsed.data.questionId, sessionId: req.params.id, session: { userId: req.userId } },
    include: { answer: { select: { mediaUrl: true } } }
  });
  if (!question) {
    await removeUpload(newMediaUrl);
    return res.status(404).json({ error: 'Question not found' });
  }

  const speechAnalysis = analyzeSpeech(parsed.data.transcript, parsed.data.durationMs);
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
    where: { id: req.params.id, userId: req.userId },
    include: { questions: { include: { answer: { include: { analyses: true } } } } }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });

  const unanswered = interview.questions.filter((question: { answer: unknown }) => !question.answer);
  if (unanswered.length > 0) {
    return res.status(409).json({
      error: 'Answer every question before completing the interview',
      unansweredQuestions: unanswered.length
    });
  }

  const scores: number[] = interview.questions.flatMap((question: { answer: { analyses: Array<{ score: number | null }> } | null }) =>
    question.answer?.analyses.flatMap((analysis: { score: number | null }) => analysis.score ?? []) ?? []
  );
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
    : null;

  const { completed, report } = await prisma.$transaction(async (tx: Pick<typeof prisma, 'interviewSession' | 'feedbackReport'>) => {
    const completed = await tx.interviewSession.update({
      where: { id: interview.id },
      data: { status: 'COMPLETED', completedAt: new Date() }
    });
    const report = await tx.feedbackReport.upsert({
      where: { sessionId: interview.id },
      update: {
        overallScore,
        summary: overallScore === null ? 'Interview completed.' : `Overall confidence score: ${overallScore}/100.`,
        details: { answeredQuestions: interview.questions.length, analysisCount: scores.length }
      },
      create: {
        sessionId: interview.id,
        overallScore,
        summary: overallScore === null ? 'Interview completed.' : `Overall confidence score: ${overallScore}/100.`,
        details: { answeredQuestions: interview.questions.length, analysisCount: scores.length }
      }
    });
    return { completed, report };
  });

  return res.json({
    interview: completed,
    report,
    answeredQuestions: interview.questions.length,
    totalQuestions: interview.questions.length
  });
});

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      questions: {
        orderBy: { order: 'asc' },
        include: { answer: { include: { analyses: true } } }
      },
      report: true
    }
  });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  // Media is private: exchange stored upload paths for short-lived signed URLs.
  const questions = interview.questions.map((question) => ({
    ...question,
    answer: question.answer
      ? { ...question.answer, mediaUrl: toSignedMediaUrl(question.answer.mediaUrl) }
      : null
  }));
  return res.json({ interview: { ...interview, questions } });
});

export default router;
