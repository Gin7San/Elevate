import { Router } from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A recording is required' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Speech transcription is not configured. Add OPENAI_API_KEY to backend/.env.' });

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
