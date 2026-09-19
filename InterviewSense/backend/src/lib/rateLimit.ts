export type RateLimiterOptions = {
  /** Length of the fixed counting window in milliseconds. */
  windowMs: number;
  /** Maximum number of hits allowed per key within one window. */
  max: number;
  /** Optional name used to namespace keys. */
  namespace?: string;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until blocked keys may try again; 0 when allowed. */
  retryAfterSeconds: number;
};

/**
 * Minimal fixed-window rate limiter with per-key counters.
 * Suitable for single-process deployments; swap for a shared store (e.g. Redis)
 * when running multiple API instances.
 */
export function createRateLimiter({ windowMs, max, namespace = 'default' }: RateLimiterOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  function key(keyPart: string) {
    return `${namespace}:${keyPart}`;
  }

  function prune(now: number) {
    // Bound memory: expired entries are removed once the map grows.
    if (hits.size < 1000) return;
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }

  return {
    hit(keyPart: string): RateLimitResult {
      const now = Date.now();
      prune(now);
      const k = key(keyPart);
      const entry = hits.get(k);
      if (!entry || entry.resetAt <= now) {
        hits.set(k, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (entry.count >= max) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    /** Visible for testing. */
    reset() {
      hits.clear();
    }
  };
}
