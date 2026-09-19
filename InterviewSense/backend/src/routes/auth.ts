import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getJwtSecret } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { clearAuthCookies, setAuthCookies } from '../lib/cookies.js';
import { isMailConfigured, sendPasswordResetEmail } from '../services/mailer.js';

const router = Router();
const optionalName = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(80).optional()
);
const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(72),
  name: optionalName
}).strict();

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254)
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().trim().min(16).max(256),
  password: z.string().min(8).max(72)
}).strict();

// Throttle reset requests: 10 per 15 minutes per client IP, 3 per hour per account.
const forgotPasswordIpLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, namespace: 'forgot-ip' });
const forgotPasswordEmailLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3, namespace: 'forgot-email' });

function createToken(userId: string) {
  return jwt.sign({}, getJwtSecret(), {
    subject: userId,
    expiresIn: '7d'
  });
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueSession(res: Parameters<typeof setAuthCookies>[0], userId: string) {
  const token = createToken(userId);
  const csrfToken = crypto.randomBytes(32).toString('hex');
  setAuthCookies(res, token, csrfToken);
  return { token, csrfToken };
}

function resetUrlFor(token: string): string {
  const origin = (process.env.CLIENT_URL ?? 'http://localhost:5173')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '') || 'http://localhost:5173';
  return `${origin}/?token=${token}`;
}

router.post('/register', async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Email and password are invalid', details: parsed.error.flatten() });
  }

  const { email, password, name } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existingUser) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, name }
    });

    const session = issueSession(res, user.id);
    return res.status(201).json({
      ...session,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error) {
    // A concurrent registration can pass the lookup above; preserve the API's 409 contract.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    throw error;
  }
});

router.post('/login', async (req, res) => {
  const parsed = credentialsSchema.pick({ email: true, password: true }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Email and password are invalid' });
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  const valid = user && await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid || !user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const session = issueSession(res, user.id);
  return res.json({
    ...session,
    user: { id: user.id, email: user.email, name: user.name }
  });
});

router.post('/logout', (_req, res) => {
  clearAuthCookies(res);
  return res.status(204).end();
});

router.post('/forgot-password', async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Valid email is required', details: parsed.error.flatten() });
  }

  const normalizedEmail = parsed.data.email.toLowerCase();
  const ipResult = forgotPasswordIpLimiter.hit(req.ip ?? 'unknown');
  const emailResult = forgotPasswordEmailLimiter.hit(normalizedEmail);
  if (!ipResult.allowed || !emailResult.allowed) {
    const retryAfter = Math.max(ipResult.retryAfterSeconds, emailResult.retryAfterSeconds);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
  }

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  // Always return the same message to prevent account enumeration.
  const genericMessage = 'If an account with that email exists, a password reset link has been sent';

  if (!user) {
    return res.json({ message: genericMessage });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = hashToken(resetToken);
  const expires = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: resetTokenHash,
      passwordResetExpires: expires
    }
  });

  if (isMailConfigured()) {
    try {
      await sendPasswordResetEmail(normalizedEmail, resetUrlFor(resetToken));
    } catch (error) {
      // Never fall back to exposing the token over the API when mail delivery
      // is expected; log the failure so operators can fix SMTP.
      console.error('Failed to send password reset email:', error);
    }
    return res.json({ message: genericMessage });
  }

  // Development fallback: without SMTP_URL the token is returned in the
  // response so local development and tests can exercise the reset flow.
  return res.json({
    message: genericMessage,
    resetToken,
    expiresAt: expires.toISOString(),
    note: 'SMTP_URL is not configured; the reset token is exposed for development use only.'
  });
});

router.post('/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Token and password are required', details: parsed.error.flatten() });
  }
  const tokenHash = hashToken(parsed.data.token);

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: tokenHash,
      passwordResetExpires: { gt: new Date() }
    }
  });

  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpires: null
    }
  });

  return res.json({ message: 'Password has been reset successfully' });
});

export default router;
