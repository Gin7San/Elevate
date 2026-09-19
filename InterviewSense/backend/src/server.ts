import 'dotenv/config';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { validateConfig } from './config.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import interviewsRouter from './routes/interviews.js';
import transcriptionRouter from './routes/transcription.js';
import mediaRouter from './routes/media.js';
import { csrfGuard } from './middleware/csrf.js';

validateConfig();

export const app = express();
const allowedOrigins = (process.env.CLIENT_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(csrfGuard);

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
app.use('/api/v1/media', mediaRouter);

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
