import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMediaSignature } from '../lib/mediaSign.js';
import { readMediaTypeHead, sniffContentType } from '../lib/mediaType.js';

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
    const head = await readMediaTypeHead(filePath);
    if (head.length === 0) throw new Error('unreadable');
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
