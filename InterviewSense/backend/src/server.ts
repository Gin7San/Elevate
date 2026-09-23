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

// Multer reports every malformed upload as a MulterError, so each code needs its
// own message; a single generic one leaves users guessing what to change.
const multerMessages: Record<string, string> = {
  LIMIT_FILE_SIZE: 'The recording must be 25 MB or smaller',
  LIMIT_FILE_COUNT: 'Only one recording can be uploaded at a time',
  LIMIT_UNEXPECTED_FILE: 'Only a recording in the "media" field is accepted',
  LIMIT_FIELD_COUNT: 'The request contains too many fields',
  LIMIT_FIELD_VALUE: 'A form field value is too large',
  LIMIT_PART_COUNT: 'The request contains too many parts'
};

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: multerMessages[error.code] ?? 'The recording upload is invalid' });
  }
  console.error(error);
  return res.status(500).json({ error: 'An unexpected server error occurred' });
});
