import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import interviewsRouter from './routes/interviews.js';
import transcriptionRouter from './routes/transcription.js';

validateConfig();

export const app = express();
const uploadsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../uploads');
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.CLIENT_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadsPath, {
  dotfiles: 'deny',
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'");
  }
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'interviewsense-api' });
});

app.get('/api/v1', (_req, res) => {
  res.json({ name: 'InterviewSense API', version: 'v1' });
});

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/me', meRouter);
app.use('/api/v1/interviews', interviewsRouter);
app.use('/api/v1/transcription', transcriptionRouter);

app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'The recording must be 25 MB or smaller'
      : 'The recording upload is invalid';
    return res.status(400).json({ error: message });
  }
  console.error(error);
  return res.status(500).json({ error: 'An unexpected server error occurred' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`InterviewSense API running on port ${port}`);
});
