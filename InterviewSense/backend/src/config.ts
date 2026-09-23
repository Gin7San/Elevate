const INSECURE_SECRETS = new Set([
  'development-secret',
  'replace-this-in-development',
  'replace-with-a-random-secret-at-least-32-characters-long'
]);

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32 || INSECURE_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET must be set to a unique value of at least 32 characters');
  }
  return secret;
}

export const TRANSCRIPTION_PROVIDERS = ['openai', 'none'] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDERS)[number];

export type TranscriptionSettings = {
  provider: TranscriptionProviderId;
  apiKey: string | null;
  /** OpenAI-compatible endpoint; lets the same code talk to Groq, Deepgram or a local whisper-server. */
  baseURL: string | null;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlSeconds: number;
  extractAudio: boolean;
  ffmpegPath: string;
  /** Final transcriptions per user per window. */
  rateLimitMax: number;
  /** Live-caption polls per user per window; a separate, larger budget. */
  liveRateLimitMax: number;
  rateLimitWindowMs: number;
};

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  const bounded = Math.trunc(value);
  if (bounded < min || bounded > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return bounded;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Reads and validates the transcription configuration. Called from
 * validateConfig() so a typo fails at boot rather than on a user's recording.
 */
export function getTranscriptionSettings(): TranscriptionSettings {
  const rawProvider = (process.env.TRANSCRIPTION_PROVIDER?.trim() || 'openai').toLowerCase();
  if (!TRANSCRIPTION_PROVIDERS.includes(rawProvider as TranscriptionProviderId)) {
    throw new Error(`TRANSCRIPTION_PROVIDER must be one of: ${TRANSCRIPTION_PROVIDERS.join(', ')}`);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() || null;
  const baseURL = (process.env.TRANSCRIPTION_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || null);
  if (baseURL !== null) {
    try {
      const parsed = new URL(baseURL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new Error('TRANSCRIPTION_BASE_URL / OPENAI_BASE_URL must be a valid http(s) URL');
    }
  }
  return {
    provider: rawProvider as TranscriptionProviderId,
    apiKey,
    baseURL,
    model: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
    timeoutMs: readInt('TRANSCRIPTION_TIMEOUT_MS', 60_000, 1_000, 600_000),
    maxRetries: readInt('TRANSCRIPTION_MAX_RETRIES', 2, 0, 5),
    cacheTtlSeconds: readInt('TRANSCRIPTION_CACHE_TTL_SECONDS', 3600, 0, 86_400),
    extractAudio: readBoolean('TRANSCRIPTION_EXTRACT_AUDIO', true),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    rateLimitMax: readInt('TRANSCRIPTION_RATE_LIMIT_MAX', 20, 1, 10_000),
    liveRateLimitMax: readInt('TRANSCRIPTION_LIVE_RATE_LIMIT_MAX', 240, 1, 10_000),
    rateLimitWindowMs: 15 * 60 * 1000
  };
}

export function validateConfig() {
  getJwtSecret();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
  getTranscriptionSettings();
}
