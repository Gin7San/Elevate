import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AUTH_COOKIE } from './auth.js';

export const CSRF_COOKIE = 'interviewsense_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Double-submit CSRF protection for cookie-authenticated browser requests.
 *
 * When the auth cookie rides along on a state-changing request, the SPA must
 * send the readable CSRF cookie back in the `X-CSRF-Token` header. Cross-site
 * attackers cannot read that cookie (same-origin policy) or set custom headers
 * without passing a CORS preflight. Bearer-token API clients carry no ambient
 * credentials and are not CSRF-able, so they are exempt. SameSite=Strict on the
 * auth cookie provides a second, browser-enforced layer.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasAuthCookie = Boolean(req.cookies?.[AUTH_COOKIE]);
  if (!hasAuthCookie) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || typeof headerToken !== 'string' || !tokensEqual(headerToken, cookieToken)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  return next();
}
