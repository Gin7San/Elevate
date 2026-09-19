import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getJwtSecret } from '../config.js';
import { prisma } from '../lib/prisma.js';

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

function createToken(userId: string) {
  return jwt.sign({}, getJwtSecret(), {
    subject: userId,
    expiresIn: '7d'
  });
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

    return res.status(201).json({
      token: createToken(user.id),
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

  return res.json({
    token: createToken(user.id),
    user: { id: user.id, email: user.email, name: user.name }
  });
});

export default router;
