import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TranscriptionSettings } from '../config.js';
import {
  clearTranscriptionCache,
  resolveTranscriptionProvider,
  transcribe,
  TranscriptionNotConfiguredError,
  TranscriptionUpstreamError
} from './transcription.js';

/**
 * Exercises the provider against a stub OpenAI-compatible
 * /audio/transcriptions endpoint. This is what makes OPENAI_BASE_URL support
 * testable: Groq, Deepgram and a self-hosted whisper-server all speak this shape.
 */

const VERBOSE_JSON = {
  task: 'transcribe',
  language: 'english',
  duration: 3,
  text: 'I led the migration',
  words: [
    { word: 'I', start: 0, end: 0.2 },
    { word: 'led', start: 0.2, end: 0.4 },
    // 0.8 s gap: counts as a pause, but not a long one.
    { word: 'the', start: 1.2, end: 1.3 },
    { word: 'migration', start: 1.3, end: 1.8 }
  ]
};

let server: http.Server;
let port: number;
let requests: Array<{ url: string; body: string }> = [];
let responder: (body: string, respond: (status: number, payload: unknown, delayMs?: number) => void) => void;

function respond(res: http.ServerResponse, status: number, payload: unknown, delayMs = 0) {
  const send = () => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      requests.push({ url: req.url ?? '', body });
      responder(body, (status, payload, delayMs) => respond(res, status, payload, delayMs));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function settings(overrides: Partial<TranscriptionSettings> = {}): TranscriptionSettings {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${port}/v1`,
    model: 'whisper-1',
    timeoutMs: 5_000,
    maxRetries: 0,
    cacheTtlSeconds: 300,
    extractAudio: false,
    ffmpegPath: 'ffmpeg',
    rateLimitMax: 20,
    liveRateLimitMax: 240,
    rateLimitWindowMs: 900_000,
    ...overrides
  };
}

const recording = { buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9]), name: 'answer.webm', type: 'video/webm' };

function useResponder(next: typeof responder) {
  responder = next;
  requests = [];
  clearTranscriptionCache();
}

test('transcribes and derives pause metrics from word timestamps', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  const result = await transcribe(recording, settings());
  assert.equal(result.transcript, 'I led the migration');
  // One 0.8 s gap between words, plus 1.2 s of trailing silence inside the
  // 3 s clip: both count as pauses, neither reaches the 2 s "long" threshold.
  assert.equal(result.pauseAnalysis.pauseCount, 2);
  assert.equal(result.pauseAnalysis.longPauseCount, 0);
  assert.equal(result.pauseAnalysis.totalPauseMs, 2000);
  assert.equal(result.pauseAnalysis.longestPauseMs, 1200);
  assert.equal(result.pauseAnalysis.speakingRate, 133, '4 words across a 1.8 s spoken span');
  assert.equal(result.pauseAnalysis.audioDurationMs, 3000);
  assert.equal(result.provider, 'openai');
  assert.equal(result.cached, false);
});

test('sends the model, word granularity and the question as prompt', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  await transcribe({ ...recording, prompt: 'Tell me about a migration you led' }, settings({ model: 'whisper-large-v3-turbo' }));
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.equal(url, '/v1/audio/transcriptions');
  assert.ok(body.includes('whisper-large-v3-turbo'), 'the configured model is sent');
  assert.ok(body.includes('verbose_json'), 'verbose_json is requested');
  assert.ok(body.includes('timestamp_granularities'), 'word granularity is requested');
  assert.ok(body.includes('name="prompt"'), 'a prompt field is present');
  assert.ok(body.includes('Tell me about a migration you led'), 'the question primes the transcription');
});

test('an over-long prompt is clamped before upload', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  await transcribe({ ...recording, prompt: 'x'.repeat(4000) }, settings());
  // clampPrompt keeps 497 characters and adds an ellipsis: 500 total.
  assert.ok(requests[0].body.includes(`${'x'.repeat(497)}...`), 'the prompt is truncated to 500 characters');
  assert.ok(!requests[0].body.includes('x'.repeat(501)), 'no more than the clamped prompt is sent');
});

test('identical audio is served from cache without a second upstream call', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  const first = await transcribe(recording, settings());
  const second = await transcribe(recording, settings());
  assert.equal(requests.length, 1, 'the second call did not reach the provider');
  assert.equal(second.cached, true);
  assert.deepEqual(second.pauseAnalysis, first.pauseAnalysis);
});

test('a different prompt does not reuse the cached transcript', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  await transcribe({ ...recording, prompt: 'first question' }, settings());
  await transcribe({ ...recording, prompt: 'second question' }, settings());
  assert.equal(requests.length, 2);
});

test('a caching-free configuration always calls through', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  await transcribe(recording, settings({ cacheTtlSeconds: 0 }));
  await transcribe(recording, settings({ cacheTtlSeconds: 0 }));
  assert.equal(requests.length, 2);
});

test('upstream failures surface as an upstream error', async () => {
  useResponder((_body, done) => done(500, { error: { message: 'boom' } }));
  await assert.rejects(
    transcribe(recording, settings()),
    (error: unknown) => error instanceof TranscriptionUpstreamError
  );
});

test('a provider response without word timestamps is rejected', async () => {
  useResponder((_body, done) => done(200, { text: 'no words here' }));
  await assert.rejects(
    transcribe(recording, settings()),
    (error: unknown) => error instanceof TranscriptionUpstreamError && /verbose_json/.test(error.message)
  );
});

test('a hung provider is abandoned at the configured timeout', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON, 4_000));
  const started = Date.now();
  await assert.rejects(
    transcribe(recording, settings({ timeoutMs: 400, maxRetries: 0 })),
    (error: unknown) => error instanceof TranscriptionUpstreamError
  );
  assert.ok(Date.now() - started < 3_000, 'the request was cut short by the timeout');
});

test('no engine is resolved without an api key', () => {
  assert.equal(resolveTranscriptionProvider(settings({ apiKey: null })), null);
  assert.equal(resolveTranscriptionProvider(settings({ provider: 'none' })), null);
  assert.ok(resolveTranscriptionProvider(settings()));
});

test('transcribing without a configured engine raises a configuration error', async () => {
  clearTranscriptionCache();
  await assert.rejects(
    transcribe(recording, settings({ apiKey: null })),
    (error: unknown) => error instanceof TranscriptionNotConfiguredError && /OPENAI_API_KEY/.test(error.message)
  );
  await assert.rejects(
    transcribe(recording, settings({ provider: 'none' })),
    (error: unknown) => error instanceof TranscriptionNotConfiguredError && /disabled/.test(error.message)
  );
});

test('reports that audio extraction was skipped when it is disabled', async () => {
  useResponder((_body, done) => done(200, VERBOSE_JSON));
  const result = await transcribe(recording, settings({ extractAudio: false }));
  assert.equal(result.audioExtracted, false);
});
