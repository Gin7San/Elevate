import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getTranscriptionSettings, type TranscriptionSettings } from '../config.js';
import { extractAudioForTranscription } from '../lib/audioExtract.js';
import { createTtlCache, type TtlCache } from '../lib/transcriptCache.js';

export type TimestampedWord = { word: string; start: number; end: number };

const PAUSE_THRESHOLD_SECONDS = 0.5;
const LONG_PAUSE_THRESHOLD_SECONDS = 2;

export type PauseAnalysis = {
  pauseCount: number;
  longPauseCount: number;
  totalPauseMs: number;
  longestPauseMs: number;
  speakingRate: number | null;
  audioDurationMs: number | null;
  timestampedTranscription: true;
};

/** Validated when the SPA echoes server-computed pause analysis with an answer. */
export const pauseAnalysisSchema = z.object({
  pauseCount: z.number().int().min(0).max(5000),
  longPauseCount: z.number().int().min(0).max(1000),
  totalPauseMs: z.number().min(0).max(100 * 60 * 1000),
  longestPauseMs: z.number().min(0).max(100 * 60 * 1000),
  speakingRate: z.number().min(0).max(600).nullable(),
  audioDurationMs: z.number().min(0).max(100 * 60 * 1000).nullable(),
  timestampedTranscription: z.literal(true)
}).strict();

/**
 * Computes pause metrics from Whisper word timestamps. A "pause" is any gap
 * >= 0.5 s between consecutive words (including leading/trailing silence when
 * the total audio duration is known); >= 2 s counts as a long pause.
 */
export function analyzeWordTimestamps(words: TimestampedWord[], audioDurationMs?: number | null): PauseAnalysis {
  let pauseCount = 0;
  let longPauseCount = 0;
  let totalPauseMs = 0;
  let longestPauseMs = 0;

  const gaps: number[] = [];
  for (let index = 1; index < words.length; index++) {
    const gap = words[index].start - words[index - 1].end;
    if (gap >= PAUSE_THRESHOLD_SECONDS) gaps.push(gap);
  }
  if (words.length > 0 && audioDurationMs) {
    if (words[0].start >= PAUSE_THRESHOLD_SECONDS) gaps.push(words[0].start);
    const trailing = audioDurationMs / 1000 - words[words.length - 1].end;
    if (trailing >= PAUSE_THRESHOLD_SECONDS) gaps.push(trailing);
  }

  for (const gap of gaps) {
    pauseCount++;
    totalPauseMs += Math.round(gap * 1000);
    longestPauseMs = Math.max(longestPauseMs, Math.round(gap * 1000));
    if (gap >= LONG_PAUSE_THRESHOLD_SECONDS) longPauseCount++;
  }

  const spokenSpanSeconds = words.length > 1 ? words[words.length - 1].end - words[0].start : 0;
  const speakingRate = spokenSpanSeconds > 0 ? Math.round(words.length / (spokenSpanSeconds / 60)) : null;

  return {
    pauseCount,
    longPauseCount,
    totalPauseMs,
    longestPauseMs,
    speakingRate,
    audioDurationMs: audioDurationMs ?? null,
    timestampedTranscription: true
  };
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

export type TranscriptionInput = {
  buffer: Buffer;
  name: string;
  type: string;
  /** The interview question, used to prime Whisper's vocabulary. */
  prompt?: string;
};

export type TranscriptionOutput = { transcript: string; pauseAnalysis: PauseAnalysis };

/**
 * A transcription engine. Anything that can turn audio into text with
 * word-level timestamps fits: a hosted OpenAI-compatible API today, a local
 * whisper.cpp or ONNX runtime later. The word timestamps are not optional —
 * analyzeWordTimestamps drives the fluency score.
 */
export type TranscriptionProvider = {
  readonly id: string;
  isConfigured(): boolean;
  transcribe(input: TranscriptionInput): Promise<TranscriptionOutput>;
};

/** Raised when no usable engine is configured; the route answers 503. */
export class TranscriptionNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionNotConfiguredError';
  }
}

/** Raised when the engine rejected or could not reach the upstream; the route answers 502. */
export class TranscriptionUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TranscriptionUpstreamError';
  }
}

// Reused across requests: constructing an OpenAI client per call also rebuilds
// its HTTP agent, which defeats connection pooling.
const clients = new Map<string, OpenAI>();

function openAiClient(settings: TranscriptionSettings): OpenAI {
  const signature = [settings.baseURL ?? 'default', settings.apiKey ?? 'no-key', settings.timeoutMs, settings.maxRetries].join('|');
  const existing = clients.get(signature);
  if (existing) return existing;
  const client = new OpenAI({
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
    timeout: settings.timeoutMs,
    maxRetries: settings.maxRetries
  });
  clients.set(signature, client);
  return client;
}

/** Whisper reads at most 224 tokens of prompt; longer text is truncated upstream anyway. */
function clampPrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

/**
 * Whisper behind any OpenAI-compatible `/audio/transcriptions` endpoint.
 * Point OPENAI_BASE_URL (or TRANSCRIPTION_BASE_URL) at Groq, Deepgram or a
 * self-hosted whisper-server and this same code path serves it.
 */
export function createOpenAiTranscriptionProvider(settings: TranscriptionSettings): TranscriptionProvider {
  return {
    id: 'openai',
    isConfigured: () => Boolean(settings.apiKey),
    async transcribe(input) {
      if (!settings.apiKey) {
        throw new TranscriptionNotConfiguredError('Speech transcription is not configured. Add OPENAI_API_KEY to backend/.env.');
      }
      const uploadable = await toFile(input.buffer, input.name, { type: input.type });
      let transcription: Awaited<ReturnType<OpenAI['audio']['transcriptions']['create']>>;
      try {
        transcription = await openAiClient(settings).audio.transcriptions.create({
          file: uploadable,
          model: settings.model,
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          ...(clampPrompt(input.prompt) ? { prompt: clampPrompt(input.prompt) } : {})
        });
      } catch (error) {
        throw new TranscriptionUpstreamError('The transcription service could not process this recording', { cause: error });
      }

      if (!transcription || typeof transcription !== 'object' || !('words' in transcription)) {
        throw new TranscriptionUpstreamError('The transcription service returned an unexpected response. Check OPENAI_TRANSCRIBE_MODEL and OPENAI_BASE_URL support verbose_json with word timestamps.');
      }

      const words: TimestampedWord[] = (transcription.words ?? [])
        .map((word) => ({ word: word.word ?? '', start: word.start ?? 0, end: word.end ?? 0 }))
        .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end));

      const audioDurationMs = typeof transcription.duration === 'number' && Number.isFinite(transcription.duration)
        ? Math.round(transcription.duration * 1000)
        : null;

      return { transcript: transcription.text ?? '', pauseAnalysis: analyzeWordTimestamps(words, audioDurationMs) };
    }
  };
}

/** Resolves the configured engine, or null when the feature is switched off or unconfigured. */
export function resolveTranscriptionProvider(settings: TranscriptionSettings = getTranscriptionSettings()): TranscriptionProvider | null {
  if (settings.provider === 'none') return null;
  const provider = createOpenAiTranscriptionProvider(settings);
  return provider.isConfigured() ? provider : null;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export type TranscriptionRequest = TranscriptionInput;
export type TranscriptionResponse = TranscriptionOutput & {
  provider: string;
  cached: boolean;
  /** False when ffmpeg was unavailable and the original upload was sent as-is. */
  audioExtracted: boolean;
};

let cache: TtlCache<TranscriptionOutput> | null = null;
let cacheKeySignature = '';

function transcriptCache(settings: TranscriptionSettings): TtlCache<TranscriptionOutput> {
  if (!cache || cacheKeySignature !== String(settings.cacheTtlSeconds)) {
    cache = createTtlCache<TranscriptionOutput>({ ttlMs: settings.cacheTtlSeconds * 1000 });
    cacheKeySignature = String(settings.cacheTtlSeconds);
  }
  return cache;
}

/** Visible for testing: drops cached transcripts. */
export function clearTranscriptionCache() {
  cache?.clear();
}

/**
 * Transcribes a recording and returns the text plus word-level pause metrics.
 *
 * Wraps the configured provider with the two things every engine needs: a
 * content-addressed cache (re-clicking "Transcribe" must not re-bill the same
 * audio) and audio extraction (the upload is a video; providers want 16 kHz
 * mono PCM).
 */
export async function transcribe(request: TranscriptionRequest, settings: TranscriptionSettings = getTranscriptionSettings()): Promise<TranscriptionResponse> {
  const provider = resolveTranscriptionProvider(settings);
  if (!provider) {
    throw new TranscriptionNotConfiguredError(
      settings.provider === 'none'
        ? 'Speech transcription is disabled (TRANSCRIPTION_PROVIDER=none).'
        : 'Speech transcription is not configured. Add OPENAI_API_KEY to backend/.env.'
    );
  }

  const prompt = clampPrompt(request.prompt);
  const cacheId = crypto
    .createHash('sha256')
    .update(`${provider.id}\u0000${settings.model}\u0000${prompt ?? ''}\u0000`)
    .update(request.buffer)
    .digest('hex');

  const store = transcriptCache(settings);
  const cached = store.get(cacheId);
  if (cached) return { ...cached, provider: provider.id, cached: true, audioExtracted: false };

  const audio = await extractAudioForTranscription(
    { buffer: request.buffer, name: request.name, type: request.type },
    { ffmpegPath: settings.ffmpegPath, enabled: settings.extractAudio, timeoutMs: Math.min(settings.timeoutMs, 60_000) }
  );

  const result = await provider.transcribe({ ...audio, prompt });
  store.set(cacheId, result);
  return { ...result, provider: provider.id, cached: false, audioExtracted: audio.extracted };
}
