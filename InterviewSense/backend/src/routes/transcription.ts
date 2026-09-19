import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { isTranscriptionConfigured, transcribeWithWhisper } from '../services/transcription.js';

const router = Router();
const acceptedMediaTypes = new Set([
  'video/webm', 'video/mp4', 'audio/webm', 'audio/mp4',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg'
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  fileFilter: (_req, file, callback) => {
    if (acceptedMediaTypes.has(file.mimetype)) callback(null, true);
    else callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'media'));
  }
});

/**
 * Transcribes a recording with word-level timestamps. The response includes a
 * server-derived pause analysis which the SPA attaches to its answer so the
 * fluency scoring runs on real pauses instead of filler-rate alone.
 */
router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A recording is required' });
  if (!isTranscriptionConfigured()) {
    return res.status(503).json({ error: 'Speech transcription is not configured. Add OPENAI_API_KEY to backend/.env.' });
  }

  try {
    const { transcript, pauseAnalysis } = await transcribeWithWhisper({
      buffer: req.file.buffer,
      name: req.file.originalname || 'answer.webm',
      type: req.file.mimetype
    });
    return res.json({ transcript, pauseAnalysis });
  } catch (error) {
    console.error('Transcription failed:', error);
    return res.status(502).json({ error: 'The transcription service could not process this recording' });
  }
});

export default router;
