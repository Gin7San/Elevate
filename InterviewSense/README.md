# InterviewSense

AI-powered mock interviews with recording, transcription, and multimodal confidence feedback.

## Stack

- Frontend: React, TypeScript, Vite
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL with Prisma
- Transcription: OpenAI Whisper API
- Analysis: speech-fluency and browser-derived voice-delivery heuristics

> Voice scores are coaching heuristics, not clinical or hiring assessments. Browser-derived metrics are validated by the API but are not tamper-proof.

## Local setup

Requirements: Node.js 22+, npm, Docker, and Docker Compose.

1. Start PostgreSQL:

   ```bash
   docker compose up -d
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

6. Optionally add `OPENAI_API_KEY` to `backend/.env` to enable recording transcription.

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
| `OPENAI_API_KEY` | No | Enables Whisper transcription |
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
npm test          # run backend unit tests
npm run check     # build and test
```

## Security and storage notes

- Authentication endpoints hash passwords with bcrypt and issue seven-day JWTs.
- The SPA session lives in a HttpOnly, SameSite=Strict cookie (`Secure` in production); nothing is stored in local storage. Bearer-token access remains available for API clients. State-changing cookie requests must echo the `interviewsense_csrf` cookie in an `X-CSRF-Token` header (double-submit CSRF protection) and `POST /api/v1/auth/logout` clears the session.
- Password reset uses `POST /api/v1/auth/forgot-password` to create a one-hour, hashed single-use token and `POST /api/v1/auth/reset-password` to set a new password. Tokens are hashed with SHA-256 and cleared after use or expiry. With `SMTP_URL` configured the reset link is emailed and never exposed in the API response; without it, the token is returned in the response as a development fallback. The endpoint is rate limited (10 attempts per 15 minutes per IP, 3 per hour per account).
- The API refuses to start with a missing, short, or known-placeholder JWT secret.
- Recording uploads are authenticated, MIME-filtered, and limited to 25 MB.
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
