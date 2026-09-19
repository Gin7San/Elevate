import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type AuthenticatedRequest = Request & { userId?: string };

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? 'development-secret');
    if (typeof payload === 'string' || !payload.sub) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
