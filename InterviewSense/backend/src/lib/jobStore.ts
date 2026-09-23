import crypto from 'node:crypto';

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export type TranscriptionJob<T> = {
  id: string;
  userId: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  result?: T;
  error?: string;
};

export type JobStore<T> = {
  create(userId: string): TranscriptionJob<T>;
  /** Owner-scoped: another user's job is indistinguishable from a missing one. */
  get(id: string, userId: string): TranscriptionJob<T> | undefined;
  transition(id: string, patch: Partial<Pick<TranscriptionJob<T>, 'state' | 'result' | 'error'>>): void;
  /** Jobs that have not finished yet — used to bound how much audio is held in memory. */
  pending(): number;
  sweep(now?: number): number;
  readonly size: number;
};

/**
 * In-memory job store for asynchronous transcription. A long answer can take
 * longer than a reverse proxy is willing to hold a single request open, so the
 * SPA posts a job and polls it instead.
 *
 * Single-process by design, matching lib/rateLimit.ts and lib/transcriptCache.ts.
 * Running more than one API instance needs a shared store (e.g. Redis or a
 * database table); the JobStore interface is the seam to swap.
 */
export function createJobStore<T>({ ttlMs, maxJobs = 500 }: { ttlMs: number; maxJobs?: number }): JobStore<T> {
  const jobs = new Map<string, TranscriptionJob<T>>();

  function sweep(now: number) {
    let removed = 0;
    for (const [id, job] of jobs) {
      if (now - job.updatedAt > ttlMs) {
        jobs.delete(id);
        removed++;
      }
    }
    // Over the cap, finished jobs go first and then the oldest of those, so a
    // burst of new work cannot evict a job that is still running.
    const finishedRank = (job: TranscriptionJob<T>) => (job.state === 'queued' || job.state === 'running' ? 1 : 0);
    const ordered = [...jobs.values()].sort((a, b) => finishedRank(a) - finishedRank(b) || a.updatedAt - b.updatedAt);
    for (const job of ordered) {
      if (jobs.size <= maxJobs) break;
      jobs.delete(job.id);
      removed++;
    }
    return removed;
  }

  return {
    create(userId) {
      const now = Date.now();
      const job: TranscriptionJob<T> = { id: crypto.randomUUID(), userId, state: 'queued', createdAt: now, updatedAt: now };
      jobs.set(job.id, job);
      // After insertion, so the cap holds immediately rather than on the next create.
      sweep(now);
      return job;
    },
    get(id, userId) {
      const job = jobs.get(id);
      if (!job || job.userId !== userId) return undefined;
      if (Date.now() - job.updatedAt > ttlMs) {
        jobs.delete(id);
        return undefined;
      }
      return job;
    },
    transition(id, patch) {
      const job = jobs.get(id);
      if (!job) return;
      Object.assign(job, patch, { updatedAt: Date.now() });
    },
    pending() {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.state === 'queued' || job.state === 'running') count++;
      }
      return count;
    },
    sweep: (now = Date.now()) => sweep(now),
    get size() {
      return jobs.size;
    }
  };
}
