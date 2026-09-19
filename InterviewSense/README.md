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
| `JWT_SECRET` | Yes | Unique secret of at least 32 characters |
| `PORT` | No | API port; defaults to `4000` |
| `CLIENT_URL` | No | Comma-separated allowed browser origins; defaults to `http://localhost:5173` |
| `OPENAI_API_KEY` | No | Enables Whisper transcription |

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
- The API refuses to start with a missing, short, or known-placeholder JWT secret.
- Recording uploads are authenticated, MIME-filtered, and limited to 25 MB.
- Development recordings are stored in `backend/uploads` and are ignored by Git.
- Production deployments should use private object storage, authenticated media delivery, HTTPS, rate limiting, and managed secrets.
- Tokens are currently stored in browser local storage. A hardened public deployment should move authentication to secure, HTTP-only cookies with CSRF protection.

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
