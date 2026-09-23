import fsp from 'node:fs/promises';

/**
 * Media type handling shared by the upload routes and private media delivery.
 *
 * The declared type on an upload cannot be trusted on its own. Browsers put the
 * full MediaRecorder type on the wire, so a Chrome recording arrives as
 * `Content-Type: video/webm;codecs=vp8,opus`. A comma in an unquoted parameter
 * value is not valid RFC 2045 syntax, so busboy discards that header entirely
 * and reports the part as `text/plain`. Declared types are therefore a hint:
 * a usable one is normalised and honoured, an unusable one falls back to
 * sniffing the file's magic bytes, and a type that is merely *wrong* is still
 * rejected.
 */

export const acceptedMediaTypes = new Set([
  'video/webm', 'video/mp4', 'audio/webm', 'audio/mp4',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg'
]);

/**
 * Values multer reports when a part carries no usable Content-Type: the header
 * was absent, or busboy rejected it as malformed (see the module comment).
 */
const unknownMediaTypes = new Set(['', 'text/plain', 'application/octet-stream']);

/** Strips parameters (`;codecs=...`) and normalises case: `VIDEO/WEBM` -> `video/webm`. */
export function normalizeMediaType(value: string | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

export function isAcceptedMediaType(value: string | undefined): boolean {
  return acceptedMediaTypes.has(normalizeMediaType(value));
}

/** True when the declared type carries no information at all. */
export function isUnknownMediaType(value: string | undefined): boolean {
  return unknownMediaTypes.has(normalizeMediaType(value));
}

/**
 * Gate used by multer's fileFilter, which runs before the file's bytes are
 * available. Only a declared type that positively contradicts the allow-list is
 * rejected here; an unusable one is deferred so the route can sniff the bytes.
 */
export function isPlausibleMediaType(value: string | undefined): boolean {
  return isAcceptedMediaType(value) || isUnknownMediaType(value);
}

export function sniffContentType(head: Buffer): string {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (head.length >= 3 && head.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'application/octet-stream';
}

/**
 * Final gate, used once the file's bytes are in hand. Returns the accepted type
 * to store/transcribe under, or null when the recording is not supported.
 *
 * Mirrors isPlausibleMediaType: a declaration that names a supported type wins,
 * a declaration that carries no information defers to the magic bytes, and a
 * declaration that names a different type is taken at its word and refused.
 */
export function resolveMediaType(declared: string | undefined, head: Buffer): string | null {
  if (isAcceptedMediaType(declared)) return normalizeMediaType(declared);
  if (!isUnknownMediaType(declared)) return null;
  const sniffed = sniffContentType(head);
  return acceptedMediaTypes.has(sniffed) ? sniffed : null;
}

/** Reads the leading bytes needed for sniffing; empty when the file is unreadable. */
export async function readMediaTypeHead(filePath: string): Promise<Buffer> {
  const head = Buffer.alloc(16);
  try {
    const handle = await fsp.open(filePath, 'r');
    try {
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.alloc(0);
  }
  return head;
}

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg'
};

/** Filename extension for a resolved media type, so uploads are named after what they are. */
export function extensionForMediaType(mediaType: string): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType] ?? 'bin';
}
