import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { analyzeSpeech } from '../services/confidence.js';
import { analyzeVoice, type VoiceMetrics } from '../services/voice.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();
const uploadsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
fs.mkdirSync(uploadsPath, { recursive: true });
const upload = multer({ dest: uploadsPath, limits: { fileSize: 100 * 1024 * 1024 } });
const createInterviewSchema = z.object({ title: z.string().trim().min(2).max(120), role: z.string().trim().min(2).max(80).optional() });
const answerSchema = z.object({ questionId: z.string().min(1), transcript: z.string().trim().min(1).max(10000), durationMs: z.number().int().positive().optional(), voiceMetrics: z.string().optional() });

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

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interviews = await prisma.interviewSession.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { questions: true } }, report: { select: { overallScore: true } } } });
  return res.json({ interviews });
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = createInterviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A title of at least 2 characters is required' });
  const interview = await prisma.interviewSession.create({ data: { userId: req.userId, title: parsed.data.title, role: parsed.data.role, questions: { create: questionsForRole(parsed.data.role).map((text, index) => ({ text, order: index + 1 })) } }, include: { questions: { orderBy: { order: 'asc' } } } });
  return res.status(201).json({ interview });
});

router.post('/:id/answers', requireAuth, upload.single('media'), async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const parsed = answerSchema.safeParse({ ...req.body, durationMs: req.body.durationMs ? Number(req.body.durationMs) : undefined });
  if (!parsed.success) return res.status(400).json({ error: 'A non-empty answer is required' });
  const question = await prisma.question.findFirst({ where: { id: parsed.data.questionId, sessionId: req.params.id, session: { userId: req.userId } } });
  if (!question) return res.status(404).json({ error: 'Question not found' });
  const answer = await prisma.answer.upsert({ where: { questionId: question.id }, update: { transcript: parsed.data.transcript, durationMs: parsed.data.durationMs, ...(req.file ? { mediaUrl: `/uploads/${req.file.filename}` } : {}) }, create: { questionId: question.id, transcript: parsed.data.transcript, durationMs: parsed.data.durationMs, mediaUrl: req.file ? `/uploads/${req.file.filename}` : undefined } });
  const speechAnalysis = analyzeSpeech(parsed.data.transcript, parsed.data.durationMs);
  const analyses = [await prisma.analysisResult.create({ data: { answerId: answer.id, kind: speechAnalysis.category, score: speechAnalysis.score, details: { metrics: speechAnalysis.metrics, limitations: speechAnalysis.limitations } } })];
  let voiceAnalysis;
  if (parsed.data.voiceMetrics) {
    try {
      voiceAnalysis = analyzeVoice(JSON.parse(parsed.data.voiceMetrics) as VoiceMetrics);
      analyses.push(await prisma.analysisResult.create({ data: { answerId: answer.id, kind: voiceAnalysis.category, score: voiceAnalysis.score, details: { metrics: voiceAnalysis.metrics, limitations: voiceAnalysis.limitations } } }));
    } catch { return res.status(400).json({ error: 'Voice analysis data is invalid' }); }
  }
  return res.json({ answer, speechAnalysis: { ...speechAnalysis, kind: speechAnalysis.category }, voiceAnalysis: voiceAnalysis ? { ...voiceAnalysis, kind: voiceAnalysis.category } : null, analysisIds: analyses.map((item) => item.id) });
});

router.post('/:id/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({ where: { id: req.params.id, userId: req.userId }, include: { questions: { include: { answer: true } } } });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  const completed = await prisma.interviewSession.update({ where: { id: interview.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  return res.json({ interview: completed, answeredQuestions: interview.questions.filter((question: { answer: unknown }) => question.answer).length, totalQuestions: interview.questions.length });
});

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const interview = await prisma.interviewSession.findFirst({ where: { id: req.params.id, userId: req.userId }, include: { questions: { orderBy: { order: 'asc' }, include: { answer: { include: { analyses: true } } } }, report: true } });
  if (!interview) return res.status(404).json({ error: 'Interview not found' });
  return res.json({ interview });
});

export default router;
