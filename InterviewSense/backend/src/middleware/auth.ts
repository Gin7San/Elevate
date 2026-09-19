import type { NextFunction, Request, Response } from 'express';
import type { ParamsFlatDictionary } from 'express-serve-static-core';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config.js';

// ParamsFlatDictionary keeps req.params values typed as `string` (Express 5's
// ParamsDictionary allows `string | string[]` for wildcard segments). Without
// this, passing req.params.id into Prisma `where` clauses breaks the client
// overload resolution and strips relation types from `include` results.
export type AuthenticatedRequest = Request<ParamsFlatDictionary> & { userId?: string; authViaCookie?: boolean };

export const AUTH_COOKIE = 'interviewsense_token';

/**
 * Accepts a bearer token (API clients) or, for the browser SPA, the HttpOnly
 * auth cookie. Cookie-carried requests are additionally guarded by the CSRF
 * double-submit check in csrfGuard.
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookieToken = req.cookies?.[AUTH_COOKIE] as string | undefined;
  const token = bearerToken ?? cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (typeof payload === 'string' || !payload.sub) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    req.userId = payload.sub;
    req.authViaCookie = !bearerToken && Boolean(cookieToken);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
