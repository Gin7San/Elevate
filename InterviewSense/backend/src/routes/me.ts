import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, name: true, createdAt: true }
  });

  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user });
});

export default router;
