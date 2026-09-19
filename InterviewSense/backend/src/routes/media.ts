import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMediaSignature } from '../lib/mediaSign.js';

const router = Router();
const uploadsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

/**
 * Private media delivery. Recordings are stored outside any public static
 * route and are served only with a short-lived HMAC signature (see
 * lib/mediaSign.ts). Signed URLs are issued alongside interview data for
 * resources owned by the authenticated user. A production deployment should
 * swap the local disk backend for private object storage; the signed-URL
 * contract between API and SPA stays the same (presigned URLs there).
 */
function sniffContentType(head: Buffer): string {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (head.length >= 3 && head.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'application/octet-stream';
}

router.get('/:filename', async (req, res) => {
  const filename = req.params.filename;
  const eRaw = typeof req.query.e === 'string' ? req.query.e : '';
  const sRaw = typeof req.query.s === 'string' ? req.query.s : '';
  const expiresAt = Number(eRaw);

  // Never leak whether a file exists without a valid signature.
  if (!verifyMediaSignature(filename, expiresAt, sRaw)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const filePath = path.join(uploadsPath, filename);
  try {
    const handle = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    await handle.close();
    res.setHeader('Content-Type', sniffContentType(head));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'");
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Not found' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
});

export default router;
