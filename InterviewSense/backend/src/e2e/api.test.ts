import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * End-to-end route tests against a real PostgreSQL database.
 *
 * Preconditions: DATABASE_URL points at a database the Prisma migrations have
 * been applied to (CI: postgres service + `prisma migrate deploy`). Runs
 * serially and truncates all tables around each test.
 */

process.env.JWT_SECRET ??= 'e2e-test-secret-e2e-test-secret-e2e-test-secret';
process.env.COOKIE_SECURE = 'false';
delete process.env.OPENAI_API_KEY;
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for e2e route tests');
}

const { app } = await import('../server.js');
const { prisma } = await import('../lib/prisma.js');

let server: Server;
let baseUrl: string;

function makeJar() {
  const jar = new Map<string, string>();
  return {
    absorb(res: Response) {
      for (const setCookie of res.headers.getSetCookie()) {
        const pair = setCookie.split(';', 1)[0];
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value || /Expires=Thu, 01 Jan 1970/i.test(setCookie)) jar.delete(name);
        else jar.set(name, value);
      }
    },
    headers(): Record<string, string> {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      return cookie ? { Cookie: cookie } : {};
    },
    get(name: string) {
      return jar.get(name);
    }
  };
}

type ApiOptions = {
  method?: string;
  json?: unknown;
  form?: FormData;
  jar?: ReturnType<typeof makeJar>;
  csrf?: boolean | 'bad-token';
  bearer?: string;
};

async function api(path: string, options: ApiOptions = {}) {
  const headers: Record<string, string> = { ...(options.jar?.headers() ?? {}) };
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  const method = options.method ?? (options.json !== undefined || options.form ? 'POST' : 'GET');
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (!['GET', 'HEAD'].includes(method) && options.csrf && options.jar) {
    const token = options.csrf === 'bad-token' ? 'bad-token' : (options.jar.get('interviewsense_csrf') ?? '');
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.form ? options.form : options.json !== undefined ? JSON.stringify(options.json) : undefined
  });
  options.jar?.absorb(res);
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as Record<string, any> | null, res };
}

async function truncateAll() {
  await prisma.analysisResult.deleteMany();
  await prisma.answer.deleteMany();
  await prisma.question.deleteMany();
  await prisma.feedbackReport.deleteMany();
  await prisma.interviewSession.deleteMany();
  await prisma.user.deleteMany();
}

const EMAIL = 'e2e@interviewsense.dev';
const PASSWORD = 'E2eTestPass123';

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  await truncateAll();
});

after(async () => {
  await truncateAll();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health endpoint responds without auth', async () => {
  const { status, body } = await api('/health');
  assert.equal(status, 200);
  assert.equal(body?.status, 'ok');
});

test('auth flow: register, /me, duplicate, login, logout', async (t) => {
  const jar = makeJar();
  const register = await api('/api/v1/auth/register', {
    json: { email: EMAIL, password: PASSWORD, name: 'E2E' }, jar
  });
  assert.equal(register.status, 201);
  assert.ok(register.body?.csrfToken, 'issues a CSRF token');
  const setCookies = register.res.headers.getSetCookie();
  assert.ok(setCookies.some((cookie) => cookie.startsWith('interviewsense_token=') && /HttpOnly/i.test(cookie)), 'token cookie is HttpOnly');
  assert.ok(setCookies.some((cookie) => /SameSite=Strict/i.test(cookie)), 'cookies are SameSite=Strict');

  await t.test('password is bcrypt-hashed in the database', async () => {
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    assert.ok(user?.passwordHash.startsWith('$2'), `hash looks like bcrypt: ${user?.passwordHash.slice(0, 4)}`);
    assert.notEqual(user?.passwordHash, PASSWORD);
  });

  const me = await api('/api/v1/me', { jar });
  assert.equal(me.status, 200);
  assert.equal(me.body?.user?.email, EMAIL);
  const anonymousMe = await api('/api/v1/me');
  assert.equal(anonymousMe.status, 401);

  const duplicate = await api('/api/v1/auth/register', { json: { email: EMAIL, password: PASSWORD } });
  assert.equal(duplicate.status, 409);

  const badLogin = await api('/api/v1/auth/login', { json: { email: EMAIL, password: 'wrong-password' } });
  assert.equal(badLogin.status, 401);

  // The jar already holds a session cookie from register, so the login is a
  // cookie-authenticated mutation and must pass the CSRF check.
  const login = await api('/api/v1/auth/login', { json: { email: EMAIL, password: PASSWORD }, jar, csrf: true });
  assert.equal(login.status, 200);

  const logout = await api('/api/v1/auth/logout', { method: 'POST', jar, csrf: true });
  assert.equal(logout.status, 204);
  const meAfterLogout = await api('/api/v1/me', { jar });
  assert.equal(meAfterLogout.status, 401);
});

test('CSRF guard blocks cookie-authenticated mutation without the header', async () => {
  const jar = makeJar();
  await api('/api/v1/auth/login', { json: { email: EMAIL, password: PASSWORD }, jar });

  const withoutCsrf = await api('/api/v1/interviews', { json: { title: 'Blocked' }, jar });
  assert.equal(withoutCsrf.status, 403);

  const withBadCsrf = await api('/api/v1/interviews', { json: { title: 'Blocked' }, jar, csrf: 'bad-token' });
  assert.equal(withBadCsrf.status, 403);

  const withCsrf = await api('/api/v1/interviews', { json: { title: 'Allowed', role: 'Backend Engineer' }, jar, csrf: true });
  assert.equal(withCsrf.status, 201);
});

test('interview pipeline: pause metrics, signed media, LLM-less report', async (t) => {
  const jar = makeJar();
  await api('/api/v1/auth/login', { json: { email: EMAIL, password: PASSWORD }, jar });

  const created = await api('/api/v1/interviews', { json: { title: 'Pipeline demo', role: 'SRE' }, jar, csrf: true });
  assert.equal(created.status, 201);
  const session = created.body!.interview as { id: string; questions: Array<{ id: string; answer: unknown }> };
  assert.equal(session.questions.length, 5);

  // Cannot complete before answering everything.
  const earlyComplete = await api(`/api/v1/interviews/${session.id}/complete`, { method: 'POST', jar, csrf: true });
  assert.equal(earlyComplete.status, 409);

  let signedMediaPath: string | null = null;
  const pauseAnalysis = {
    pauseCount: 3, longPauseCount: 1, totalPauseMs: 2100, longestPauseMs: 2100,
    speakingRate: 140, audioDurationMs: 12000, timestampedTranscription: true
  };

  for (const [index, question] of session.questions.entries()) {
    const form = new FormData();
    form.set('questionId', question.id);
    form.set('transcript', index === 0
      ? 'I led a migration that cut p99 latency in half by removing a chatty dependency.'
      : `Answer ${index + 1}: I approach it methodically and measure the result.`);
    form.set('durationMs', '12000');
    form.set('pauseAnalysis', JSON.stringify(pauseAnalysis));
    form.set('voiceMetrics', JSON.stringify({
      durationMs: 12000, averageRms: 0.1, energyStd: 0.02, silenceRatio: 0.1,
      longPauseCount: 1, zeroCrossingMean: 0.1, zeroCrossingStd: 0.04
    }));
    if (index === 0) {
      // EBML magic + filler bytes: exercises the media pipeline + content-type sniffing.
      const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      form.set('media', new Blob([bytes], { type: 'video/webm' }), 'answer.webm');
    }
    const answered = await api(`/api/v1/interviews/${session.id}/answers`, { form, jar, csrf: true });
    assert.equal(answered.status, 200, `answer ${index + 1} saved: ${JSON.stringify(answered.body)}`);
    const analyses = answered.body!.analyses ?? [];
    assert.ok(Array.isArray(analyses) || answered.body!.analysisIds, 'returns analysis ids');
    if (index === 0) {
      signedMediaPath = (answered.body!.answer as { mediaUrl?: string }).mediaUrl ?? null;
      assert.ok(signedMediaPath?.startsWith('/api/v1/media/'), `answer mediaUrl is signed: ${signedMediaPath}`);
    } else {
      assert.equal((answered.body!.answer as { mediaUrl?: unknown }).mediaUrl, null);
    }
  }

  await t.test('speech analysis stored real pause metrics without limitations', async () => {
    const stored = await prisma.analysisResult.findFirst({
      where: { kind: 'SPEECH_FLUENCY', answer: { question: { sessionId: session.id } } }
    });
    assert.ok(stored, 'SPEECH_FLUENCY analysis stored');
    const details = stored!.details as { metrics?: Record<string, unknown>; limitations?: string[] };
    assert.equal(details.metrics?.pauseCount, 3);
    assert.equal(details.metrics?.timestampedTranscription, true);
    assert.ok(Number.isFinite(details.metrics?.pauseScore));
  });

  await t.test('signed media URLs stream privately', async () => {
    assert.ok(signedMediaPath);
    const okRes = await fetch(`${baseUrl}${signedMediaPath}`);
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get('content-type'), 'video/webm');
    assert.match(okRes.headers.get('cache-control') ?? '', /no-store/);
    const filename = signedMediaPath!.split('?')[0].split('/').pop();
    const unsigned = await fetch(`${baseUrl}/api/v1/media/${filename}`);
    assert.equal(unsigned.status, 404);
    const oldStatic = await fetch(`${baseUrl}/uploads/${filename}`);
    assert.equal(oldStatic.status, 404);
  });

  const completed = await api(`/api/v1/interviews/${session.id}/complete`, { method: 'POST', jar, csrf: true });
  assert.equal(completed.status, 200);
  const report = completed.body!.report as { overallScore: number; summary: string; details: Record<string, unknown> };
  assert.ok(typeof report.overallScore === 'number');
  assert.ok(report.summary.length > 40, 'report carries a narrative summary');
  const details = report.details as { answeredQuestions?: unknown; strengths?: unknown; usedLlm?: unknown };
  assert.equal(details.answeredQuestions, 5);
  assert.ok(Array.isArray(details.strengths));
  assert.equal(details.usedLlm, false, 'falls back to offline summary without OPENAI_API_KEY');

  const fetched = await api(`/api/v1/interviews/${session.id}`, { jar });
  assert.equal(fetched.status, 200);
  const fetchedReport = fetched.body!.interview.report as { summary?: string } | null;
  assert.ok(fetchedReport?.summary?.length, 'report is included when fetching the interview');
});

test('password reset: dev fallback token then reset then login', async (t) => {
  const forgot = await api('/api/v1/auth/forgot-password', { json: { email: EMAIL } });
  assert.equal(forgot.status, 200);
  const resetToken = forgot.body?.resetToken as string | undefined;
  assert.ok(resetToken, 'dev fallback returns the reset token without SMTP');
  assert.ok(forgot.body?.note, 'dev fallback is explicitly labelled');

  const badReset = await api('/api/v1/auth/reset-password', { json: { token: 'x'.repeat(32), password: 'E2eNewPass123' } });
  assert.equal(badReset.status, 400);

  const reset = await api('/api/v1/auth/reset-password', { json: { token: resetToken, password: 'E2eNewPass123' } });
  assert.equal(reset.status, 200);

  const oldLogin = await api('/api/v1/auth/login', { json: { email: EMAIL, password: PASSWORD } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api('/api/v1/auth/login', { json: { email: EMAIL, password: 'E2eNewPass123' } });
  assert.equal(newLogin.status, 200);

  await t.test('reset token is single-use', async () => {
    const reuse = await api('/api/v1/auth/reset-password', { json: { token: resetToken, password: 'Whatever123' } });
    assert.equal(reuse.status, 400);
  });
});

test('deleting an interview removes the session, media, and is owner-scoped', async () => {
  const owner = makeJar();
  const registered = await api('/api/v1/auth/register', {
    json: { email: 'owner-delete@interviewsense.dev', password: PASSWORD, name: 'Owner' },
    jar: owner
  });
  assert.equal(registered.status, 201);

  const created = await api('/api/v1/interviews', {
    json: { title: 'Disposable session', role: 'Designer' },
    jar: owner,
    csrf: true
  });
  assert.equal(created.status, 201);
  const session = created.body!.interview as { id: string; questions: Array<{ id: string }> };

  const form = new FormData();
  form.set('questionId', session.questions[0].id);
  form.set('transcript', 'A short answer worth keeping until the session is deleted.');
  form.set('durationMs', '4000');
  form.set('media', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])], { type: 'video/webm' }), 'answer.webm');
  const answered = await api(`/api/v1/interviews/${session.id}/answers`, { form, jar: owner, csrf: true });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const signedMediaPath = answered.body!.answer.mediaUrl as string;
  assert.ok(signedMediaPath?.startsWith('/api/v1/media/'), `signed media path: ${signedMediaPath}`);

  const listed = await api('/api/v1/interviews', { jar: owner });
  const row = (listed.body!.interviews as Array<{ id: string; answeredCount?: number }>).find((item) => item.id === session.id);
  assert.equal(row?.answeredCount, 1, 'list includes how many questions have been answered');

  const missingCsrf = await api(`/api/v1/interviews/${session.id}`, { method: 'DELETE', jar: owner });
  assert.equal(missingCsrf.status, 403);

  const stranger = makeJar();
  const strangerRegister = await api('/api/v1/auth/register', {
    json: { email: 'stranger-delete@interviewsense.dev', password: PASSWORD },
    jar: stranger
  });
  assert.equal(strangerRegister.status, 201);
  const notOwner = await api(`/api/v1/interviews/${session.id}`, { method: 'DELETE', jar: stranger, csrf: true });
  assert.equal(notOwner.status, 404);

  const removed = await api(`/api/v1/interviews/${session.id}`, { method: 'DELETE', jar: owner, csrf: true });
  assert.equal(removed.status, 204);
  const gone = await api(`/api/v1/interviews/${session.id}`, { jar: owner });
  assert.equal(gone.status, 404);
  const after = await api('/api/v1/interviews', { jar: owner });
  assert.equal((after.body!.interviews as unknown[]).length, 0);
  const media = await fetch(`${baseUrl}${signedMediaPath}`);
  assert.equal(media.status, 404, 'deleted recordings are no longer served');
});

test('transcription endpoint guards auth and configuration', async () => {
  const unauthenticated = await api('/api/v1/transcription', { form: new FormData() });
  assert.equal(unauthenticated.status, 401);

  const jar = makeJar();
  await api('/api/v1/auth/login', { json: { email: EMAIL, password: 'E2eNewPass123' }, jar });
  const form = new FormData();
  form.set('media', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' }), 'a.webm');
  const notConfigured = await api('/api/v1/transcription', { form, jar, csrf: true });
  assert.equal(notConfigured.status, 503);
});
