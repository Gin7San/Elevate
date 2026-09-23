/**
 * Bounded TTL cache with LRU-ish eviction. Used for transcription results: the
 * SPA can re-request the same recording, and re-running Whisper on identical
 * audio costs money and wall-clock time for a byte-identical answer.
 *
 * Single-process only, like the rate limiter — a multi-instance deployment
 * should back this with Redis so the cache and the job store are shared.
 */
export type TtlCache<T> = {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
};

export function createTtlCache<T>({ ttlMs, maxEntries = 200 }: { ttlMs: number; maxEntries?: number }): TtlCache<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();

  function prune(now: number) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      // Re-insert to mark as most-recently-used.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (ttlMs <= 0) return;
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (entries.size > maxEntries) {
        prune(Date.now());
      }
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}
