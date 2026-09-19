import type { Response } from 'express';
import { AUTH_COOKIE } from '../middleware/auth.js';
import { CSRF_COOKIE } from '../middleware/csrf.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Cookies are Secure in production unless explicitly overridden. */
export function useSecureCookies(): boolean {
  const explicit = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function baseOptions() {
  return {
    sameSite: 'strict' as const,
    secure: useSecureCookies(),
    path: '/'
  };
}

/**
 * Issues the session cookie (HttpOnly) plus a readable CSRF cookie the SPA
 * echoes back in the X-CSRF-Token header on unsafe requests.
 */
export function setAuthCookies(res: Response, token: string, csrfToken: string) {
  res.cookie(AUTH_COOKIE, token, { ...baseOptions(), httpOnly: true, maxAge: SEVEN_DAYS_MS });
  res.cookie(CSRF_COOKIE, csrfToken, { ...baseOptions(), httpOnly: false, maxAge: SEVEN_DAYS_MS });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(AUTH_COOKIE, { ...baseOptions(), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...baseOptions(), httpOnly: false });
}
