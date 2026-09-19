import { Router } from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import { requireAuth } from '../middleware/auth.js';

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

router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A recording is required' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Speech transcription is not configured. Add OPENAI_API_KEY to backend/.env.' });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await toFile(req.file.buffer, req.file.originalname || 'answer.webm', { type: req.file.mimetype });
    const transcription = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
    return res.json({ transcript: transcription.text });
  } catch (error) {
    console.error('Transcription failed:', error);
    return res.status(502).json({ error: 'The transcription service could not process this recording' });
  }
});

export default router;
