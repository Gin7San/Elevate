# InterviewSense

AI-powered mock interviews with recording, transcription, and multimodal confidence feedback.

## Stack

- Frontend: React, TypeScript, Vite
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL with Prisma
- Transcription: OpenAI Whisper API with word-level timestamps
- Analysis: speech-fluency scoring driven by real pause metrics (from timestamped transcription), browser-derived voice-delivery scoring with tunable calibration, and narrative feedback reports (LLM-written when configured, deterministic offline otherwise)

> Scores are coaching heuristics, not clinical or hiring assessments. Browser-derived metrics are validated by the API but are not tamper-proof.

## Analysis pipeline

1. **Timestamped transcription.** `POST /api/v1/transcription` (and its asynchronous twin, `POST /api/v1/transcription/jobs` + `GET /api/v1/transcription/jobs/:id`) calls Whisper with `response_format: verbose_json` and `timestamp_granularities: ['word']` through any OpenAI-compatible endpoint. The interview question is sent as `prompt` so Whisper's vocabulary is primed for the domain being discussed, and the upload is re-encoded to 16 kHz mono audio with ffmpeg first when available. The response includes a server-derived pause analysis (pause count, long pauses ≥ 2 s, total/longest pause durations, spoken-span speaking rate). The SPA attaches it to the answer, so `confidence.ts` computes fluency from filler rate **and** real pauses; without it, the response explicitly lists that limitation in `AnalysisResult.details.limitations`. Identical audio is served from a content-addressed cache, both endpoints are rate limited per user, and while recording the SPA polls for live captions.
2. **Voice delivery calibration.** `voice.ts` scores energy, consistency, pitch variation, and pause behavior against named calibration targets (`VOICE_CALIBRATION_DEFAULTS`). Calibration protocol: record 20–30 pilot sessions with at least two microphone setups, have 2+ reviewers rate perceived delivery confidence, then adjust the targets — deployed values can be overridden without redeploys via `VOICE_CALIBRATION_JSON` (validated against a strict schema). Metrics and limitations are stored in `AnalysisResult.details` and surfaced in the UI under each answer's analysis panel.
3. **Report generation.** `POST /api/v1/interviews/:id/complete` scores the interview and builds a `FeedbackReport` with a narrative `summary`, `strengths`, and `improvements`. With `OPENAI_API_KEY` set (model via `OPENAI_REPORT_MODEL`, default `gpt-4o-mini`) the summary is LLM-written; otherwise a deterministic offline summary is derived from the recorded analyses. The UI renders the report on the completed interview screen and the score on the dashboard history.

## In the product

The dashboard summarizes sessions, average score, and interviews still in progress, and charts completed scores. Opening an in-progress interview resumes at the first unanswered question. Completed interviews open in review: move between questions, edit an answer, and update the report. Sessions can be deleted from the history list; stored recordings are removed with them. The recorder shows a live timer and asks you to stop before leaving mid-recording.

## Local setup

Requirements: Node.js 22+, npm, Docker, and Docker Compose.

1. Start PostgreSQL (only the database service; run the apps natively for development):

   ```bash
   docker compose up -d postgres
   ```

2. Install dependencies:

   ```bash
   npm ci
   npm ci --prefix backend
   npm ci --prefix frontend
   ```

3. Create the backend environment file:

   ```bash
   cp backend/.env.example backend/.env
   ```

4. Replace `JWT_SECRET` with a random value containing at least 32 characters. For example:

   ```bash
   openssl rand -base64 48
   ```

5. Generate the Prisma client and apply migrations:

   ```bash
   npm run prisma --prefix backend -- generate
   npm run prisma --prefix backend -- migrate dev
   ```

6. Optionally add `OPENAI_API_KEY` to `backend/.env` to enable recording transcription. Any OpenAI-compatible endpoint works — set `OPENAI_BASE_URL` (for example `https://api.groq.com/openai/v1` with `OPENAI_TRANSCRIBE_MODEL=whisper-large-v3-turbo`). Installing `ffmpeg` (`apt install ffmpeg`, `brew install ffmpeg`) lets the API shrink each upload to 16 kHz mono audio first; without it the original recording is sent upstream instead.

7. Start both applications:

   ```bash
   npm run dev
   ```

Frontend: <http://localhost:5173>

Backend health check: <http://localhost:4000/health>

The Vite development server proxies `/api` and `/uploads` to the backend, so browser code does not depend on a hardcoded localhost API URL.

## Environment variables

### Backend

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `JWT_SECRET` | Yes | Unique secret of at least 32 characters; also signs media URLs |
| `PORT` | No | API port; defaults to `4000` |
| `CLIENT_URL` | No | Comma-separated allowed browser origins; defaults to `http://localhost:5173` |
| `OPENAI_API_KEY` | No | Enables Whisper transcription and LLM-written report summaries |
| `OPENAI_BASE_URL` | No | OpenAI-compatible base URL for transcription (Groq, Deepgram, a self-hosted whisper-server); defaults to OpenAI |
| `TRANSCRIPTION_BASE_URL` | No | Overrides `OPENAI_BASE_URL` for transcription only |
| `TRANSCRIPTION_PROVIDER` | No | `openai` (default) or `none` to disable transcription |
| `OPENAI_TRANSCRIBE_MODEL` | No | Whisper model name; defaults to `whisper-1` |
| `TRANSCRIPTION_TIMEOUT_MS` | No | Per-call upstream timeout; defaults to `60000` |
| `TRANSCRIPTION_MAX_RETRIES` | No | Upstream retries (0–5); defaults to `2` |
| `TRANSCRIPTION_CACHE_TTL_SECONDS` | No | How long an identical recording is served from cache (0 disables); defaults to `3600` |
| `TRANSCRIPTION_EXTRACT_AUDIO` | No | Re-encode uploads to 16 kHz mono WAV with ffmpeg; defaults to `true` |
| `FFMPEG_PATH` | No | ffmpeg binary path; defaults to `ffmpeg` |
| `TRANSCRIPTION_RATE_LIMIT_MAX` | No | Final transcriptions per user per 15 minutes; defaults to `20` |
| `TRANSCRIPTION_LIVE_RATE_LIMIT_MAX` | No | Live-caption polls per user per 15 minutes; defaults to `240` |
| `OPENAI_REPORT_MODEL` | No | Chat model for report summaries; defaults to `gpt-4o-mini` |
| `VOICE_CALIBRATION_JSON` | No | JSON overrides for voice scoring calibration targets |
| `SMTP_URL` | No | SMTP connection string; enables email delivery of password-reset links |
| `SMTP_FROM` | No | Sender address for reset emails |
| `COOKIE_SECURE` | No | Force `Secure` cookies on/off; defaults to Secure only when `NODE_ENV=production` |
| `MEDIA_URL_TTL_SECONDS` | No | Signed media URL lifetime (60–3600); defaults to `900` |

### Frontend

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_API_URL` | No | API base URL; defaults to `/api/v1` |
| `VITE_MEDIA_URL` | No | Media origin; defaults to the current origin |

For production, route `/api` and `/uploads` to the backend on the same origin when possible. If separate origins are used, configure both frontend variables and add the frontend origin to `CLIENT_URL`.

## Commands

From `InterviewSense/`:

```bash
npm run dev       # run frontend and backend in development
npm run build     # build both applications
npm test          # backend unit tests (services and lib, no database needed)
npm run test:e2e  # e2e route tests (needs DATABASE_URL with migrations applied)
npm run check     # build and unit tests
```

The e2e suite covers auth, CSRF, the interview/analysis pipeline, signed media
delivery, and password reset against a real PostgreSQL database. In CI it runs
against a postgres service container after `prisma migrate deploy`.

## Full stack with Docker

For development, start only PostgreSQL (`docker compose up -d postgres`) and run the apps natively as above. To run everything containerized:

```bash
JWT_SECRET=$(openssl rand -base64 48) docker compose up --build
```

The compose stack builds production images for the backend (applies migrations on boot) and the frontend (nginx serving the SPA and proxying `/api` to the backend). The app is then available at <http://localhost:8080>. Set `OPENAI_API_KEY`/`SMTP_URL` in the environment to enable transcription/report emails there too.

## Security and storage notes

- Authentication endpoints hash passwords with bcrypt and issue seven-day JWTs.
- The SPA session lives in a HttpOnly, SameSite=Strict cookie (`Secure` in production); nothing is stored in local storage. Bearer-token access remains available for API clients. State-changing cookie requests must echo the `interviewsense_csrf` cookie in an `X-CSRF-Token` header (double-submit CSRF protection) and `POST /api/v1/auth/logout` clears the session.
- Password reset uses `POST /api/v1/auth/forgot-password` to create a one-hour, hashed single-use token and `POST /api/v1/auth/reset-password` to set a new password. Tokens are hashed with SHA-256 and cleared after use or expiry. With `SMTP_URL` configured the reset link is emailed and never exposed in the API response; without it, the token is returned in the response as a development fallback. The endpoint is rate limited (10 attempts per 15 minutes per IP, 3 per hour per account).
- The API refuses to start with a missing, short, or known-placeholder JWT secret.
- Recording uploads are authenticated, MIME-filtered, and limited to 25 MB. Deleting a session removes its questions, analyses, report, and any stored recordings.
- Recordings are private: there is no public static route. The API issues short-lived HMAC-signed media URLs (`/api/v1/media/...`, TTL via `MEDIA_URL_TTL_SECONDS`) signed with `JWT_SECRET`, served with `nosniff`, CSP, and no-store headers. Production deployments should move the backing store to private object storage with presigned URLs — the API/SPA contract stays the same.
- Production deployments should additionally use HTTPS everywhere, rate limiting at the edge, and managed secrets.

## Database changes

Development:

```bash
npm run prisma --prefix backend -- migrate dev
```

Production:

```bash
npm run prisma --prefix backend -- migrate deploy
```

The analysis uniqueness migration removes older duplicate results before enforcing one result per answer and analysis category.
