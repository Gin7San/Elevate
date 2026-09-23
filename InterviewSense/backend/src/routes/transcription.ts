import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { getTranscriptionSettings, type TranscriptionSettings } from '../config.js';
import { createRateLimiter, type RateLimitResult } from '../lib/rateLimit.js';
import { isPlausibleMediaType, resolveMediaType, extensionForMediaType } from '../lib/mediaType.js';
import { createJobStore } from '../lib/jobStore.js';
import {
  transcribe,
  TranscriptionNotConfiguredError,
  TranscriptionUpstreamError,
  type TranscriptionOutput
} from '../services/transcription.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  // media + prompt + live
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  // Browsers declare the full MediaRecorder type (`video/webm;codecs=vp8,opus`),
  // which busboy cannot parse and reports as `text/plain`. The declared type is
  // therefore only rejected here when it contradicts the allow-list; otherwise
  // the handler below decides using the file's own bytes.
  fileFilter: (_req, file, callback) => {
    if (isPlausibleMediaType(file.mimetype)) callback(null, true);
    else callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'media'));
  }
});

const UNSUPPORTED_MEDIA_ERROR = 'The recording format is not supported. Record again in the browser, or upload a WebM, MP4, WAV, OGG or MP3 file.';

/**
 * Held until the job finishes: transcription of a long answer can outlast a
 * reverse proxy's patience with a single request, so the SPA posts a job and
 * polls it. Bounded by MAX_PENDING_JOBS so a burst cannot pin the uploads in RAM.
 */
const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_JOBS = 8;
const jobs = createJobStore<TranscriptionOutput>({ ttlMs: JOB_TTL_MS, maxJobs: 50 });
const pendingUploads = new Map<string, { buffer: Buffer; name: string; type: string; prompt?: string }>();

// Limiters are rebuilt when the settings change so tests (and a hot-reloaded
// config) can vary them without a module reload.
let limiters: { final: ReturnType<typeof createRateLimiter>; live: ReturnType<typeof createRateLimiter>; signature: string } | null = null;
function getLimiters(settings: TranscriptionSettings) {
  const signature = `${settings.rateLimitMax}|${settings.liveRateLimitMax}|${settings.rateLimitWindowMs}`;
  if (!limiters || limiters.signature !== signature) {
    limiters = {
      final: createRateLimiter({ windowMs: settings.rateLimitWindowMs, max: settings.rateLimitMax, namespace: 'transcribe-final' }),
      live: createRateLimiter({ windowMs: settings.rateLimitWindowMs, max: settings.liveRateLimitMax, namespace: 'transcribe-live' }),
      signature
    };
  }
  return limiters;
}

function applyRateLimit(req: Request, res: Response, live: boolean): boolean {
  const settings = getTranscriptionSettings();
  const { final, live: liveLimiter } = getLimiters(settings);
  const userId = (req as AuthenticatedRequest).userId ?? 'anonymous';
  const verdict: RateLimitResult = (live ? liveLimiter : final).hit(userId);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    res.status(429).json({ error: 'Too many transcription requests. Please wait before trying again.' });
    return false;
  }
  return true;
}

function sendTranscriptionError(res: Response, error: unknown) {
  if (error instanceof TranscriptionNotConfiguredError) return res.status(503).json({ error: error.message });
  if (error instanceof TranscriptionUpstreamError) {
    console.error('Transcription failed:', error.cause ?? error);
    return res.status(502).json({ error: error.message });
  }
  console.error('Transcription failed:', error);
  return res.status(502).json({ error: 'The transcription service could not process this recording' });
}

/** Validates the uploaded bytes once the whole file is buffered. */
function mediaTypeOf(file: Express.Multer.File | undefined): string | null {
  if (!file) return null;
  return resolveMediaType(file.mimetype, file.buffer.subarray(0, 16));
}

function readPrompt(req: Request): string | undefined {
  const prompt = req.body?.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt.slice(0, 1000) : undefined;
}

function isLiveRequest(req: Request): boolean {
  return req.body?.live === '1' || req.body?.live === 'true';
}

/**
 * Transcribes a recording with word-level timestamps. The response includes a
 * server-derived pause analysis which the SPA attaches to its answer so the
 * fluency scoring runs on real pauses instead of filler-rate alone.
 */
router.post('/', requireAuth, upload.single('media'), async (req: AuthenticatedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'A recording is required' });
  const mediaType = mediaTypeOf(req.file);
  if (!mediaType) return res.status(415).json({ error: UNSUPPORTED_MEDIA_ERROR });
  if (!applyRateLimit(req, res, isLiveRequest(req))) return;

  try {
    const result = await transcribe({
      buffer: req.file.buffer,
      // The declared name and type can disagree with the bytes (see the
      // fileFilter note), so both are derived from the resolved media type.
      name: `answer.${extensionForMediaType(mediaType)}`,
      type: mediaType,
      prompt: readPrompt(req)
    });
    return res.json(result);
  } catch (error) {
    return sendTranscriptionError(res, error);
  }
});

/**
 * Queues a transcription job and answers immediately with its id. Poll
 * GET /jobs/:id until the state leaves "running".
 */
router.post('/jobs', requireAuth, upload.single('media'), (req: AuthenticatedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'A recording is required' });
  const mediaType = mediaTypeOf(req.file);
  if (!mediaType) return res.status(415).json({ error: UNSUPPORTED_MEDIA_ERROR });
  if (!applyRateLimit(req, res, false)) return;
  if (jobs.pending() >= MAX_PENDING_JOBS) {
    return res.status(429).json({ error: 'The transcription queue is busy. Please wait a moment and try again.' });
  }
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const job = jobs.create(req.userId);
  pendingUploads.set(job.id, {
    buffer: req.file.buffer,
    name: `answer.${extensionForMediaType(mediaType)}`,
    type: mediaType,
    prompt: readPrompt(req)
  });

  res.status(202).json({ jobId: job.id, state: job.state });

  void (async () => {
    jobs.transition(job.id, { state: 'running' });
    try {
      const payload = pendingUploads.get(job.id);
      if (!payload) throw new TranscriptionUpstreamError('The upload for this job is no longer available');
      const result = await transcribe(payload);
      jobs.transition(job.id, { state: 'completed', result });
    } catch (error) {
      if (error instanceof TranscriptionNotConfiguredError) {
        jobs.transition(job.id, { state: 'failed', error: error.message });
      } else {
        console.error('Transcription job failed:', error);
        jobs.transition(job.id, {
          state: 'failed',
          error: error instanceof TranscriptionUpstreamError ? error.message : 'The transcription service could not process this recording'
        });
      }
    } finally {
      pendingUploads.delete(job.id);
    }
  })();
});

router.get('/jobs/:jobId', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const job = jobs.get(req.params.jobId, req.userId);
  if (!job) return res.status(404).json({ error: 'Transcription job not found' });

  if (job.state === 'completed' && job.result) {
    return res.json({ jobId: job.id, state: job.state, ...job.result });
  }
  if (job.state === 'failed') {
    return res.status(200).json({ jobId: job.id, state: job.state, error: job.error ?? 'Transcription failed' });
  }
  return res.json({ jobId: job.id, state: job.state });
});

export default router;
