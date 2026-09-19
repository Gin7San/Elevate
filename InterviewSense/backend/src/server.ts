import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import interviewsRouter from './routes/interviews.js';
import transcriptionRouter from './routes/transcription.js';

const app = express();
const uploadsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../uploads');
app.use('/uploads', express.static(uploadsPath));
const port = Number(process.env.PORT ?? 4000);

app.use(cors({ origin: process.env.CLIENT_URL ?? 'http://localhost:5173' }));
app.use(express.json());

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

app.listen(port, () => {
  console.log(`InterviewSense API running on http://localhost:${port}`);
});
