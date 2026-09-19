import crypto from 'node:crypto';
import { getJwtSecret } from '../config.js';

const FILENAME_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_TTL_SECONDS = 15 * 60;

export function getMediaUrlTtlSeconds(): number {
  const raw = Number(process.env.MEDIA_URL_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.trunc(raw), 60), 3600);
}

function signatureFor(filename: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(`media:${filename}:${expiresAt}`)
    .digest('hex');
}

export function isSafeMediaFilename(filename: string): boolean {
  return FILENAME_PATTERN.test(filename);
}

/**
 * Creates a short-lived, signed path for a stored recording. The signature is
 * derived from JWT_SECRET, so it cannot be forged without the server secret,
 * and it expires automatically.
 */
export function signMediaUrl(filename: string, ttlSeconds = getMediaUrlTtlSeconds()): string {
  if (!isSafeMediaFilename(filename)) {
    throw new Error('Invalid media filename');
  }
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signatureFor(filename, expiresAt);
  return `/api/v1/media/${filename}?e=${expiresAt}&s=${signature}`;
}

/**
 * Maps a stored mediaUrl (`/uploads/<file>`) to a fresh signed URL. Values that
 * do not reference local storage are returned unchanged so external storage
 * URLs keep working.
 */
export function toSignedMediaUrl(mediaUrl: string | null | undefined): string | null {
  if (!mediaUrl) return null;
  const prefix = '/uploads/';
  if (!mediaUrl.startsWith(prefix)) return mediaUrl;
  const filename = mediaUrl.slice(prefix.length);
  if (!isSafeMediaFilename(filename)) return null;
  return signMediaUrl(filename);
}

export function verifyMediaSignature(filename: string, expiresAt: number, signature: string): boolean {
  if (!isSafeMediaFilename(filename)) return false;
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signatureFor(filename, expiresAt);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
