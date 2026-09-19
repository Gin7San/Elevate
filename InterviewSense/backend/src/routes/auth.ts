import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const router = Router();
const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(80).optional()
});

function createToken(userId: string) {
  return jwt.sign({}, process.env.JWT_SECRET ?? 'development-secret', {
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
  const user = await prisma.user.create({
    data: { email: normalizedEmail, passwordHash, name }
  });

  return res.status(201).json({
    token: createToken(user.id),
    user: { id: user.id, email: user.email, name: user.name }
  });
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
