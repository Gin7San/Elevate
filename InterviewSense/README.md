# InterviewSense

AI-powered mock interviews and multimodal confidence assessment.

## Stack

- Frontend: React, TypeScript, Vite
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL with Prisma
- Planned analysis: Whisper, MediaPipe, Librosa, and an LLM API

## Start PostgreSQL

```bash
docker compose up -d
```

## Install dependencies

```bash
npm install
npm run install:all
```

Copy `backend/.env.example` to `backend/.env`, then initialize Prisma. The API includes authentication, interview-session routes, multipart answer recording uploads, and an initial speech-confidence analysis engine. Recorded files are stored in `backend/uploads` during development; production storage should use an object-storage service.

Initialize Prisma:

```bash
cd backend
npx prisma migrate dev --name init
```

## Run the app

From the project root:

```bash
npm run dev
```

Frontend: http://localhost:5173  
Backend: http://localhost:4000/health
