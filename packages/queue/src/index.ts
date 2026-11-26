import { Queue, UnrecoverableError, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Queue catalogue (Master Plan §8)                                    */
/* ------------------------------------------------------------------ */
export const QUEUE_NAMES = ['discovery', 'collection', 'analytics', 'ai', 'report', 'notification', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const JOB_NAMES = {
  ACCOUNT_SYNC: 'account.sync',
  PROVIDER_HEALTH: 'provider.health',
  METRICS_REFRESH: 'post.metrics_refresh',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const JOB_QUEUE: Record<JobName, QueueName> = {
  'account.sync': 'collection',
  'provider.health': 'maintenance',
  'post.metrics_refresh': 'collection',
};

export const accountSyncPayload = z.object({
  accountId: z.uuid(),
  projectId: z.uuid().nullable(),
  trigger: z.enum(['track', 'manual', 'schedule', 'retry']),
});
export type AccountSyncPayload = z.infer<typeof accountSyncPayload>;

export const providerHealthPayload = z.object({ providerId: z.string().nullable() });
export type ProviderHealthPayload = z.infer<typeof providerHealthPayload>;

/** accountId null = every tracked account (optionally limited to one project). */
export const metricsRefreshPayload = z.object({
  accountId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  trigger: z.enum(['manual', 'schedule', 'retry']),
});
export type MetricsRefreshPayload = z.infer<typeof metricsRefreshPayload>;

export const PAYLOAD_SCHEMAS = {
  'account.sync': accountSyncPayload,
  'provider.health': providerHealthPayload,
  'post.metrics_refresh': metricsRefreshPayload,
} as const;

/**
 * Deterministic idempotency key (Master Plan §8): project + operation + resource [+ window].
 * Manual and scheduled runs share the same key, so the DB partial unique index
 * (one QUEUED/RUNNING job per key) prevents duplicate concurrent work.
 */
export function idempotencyKey(parts: { op: JobName; resource: string; projectId?: string | null; window?: string }): string {
  return [parts.op, parts.projectId ?? '-', parts.resource, parts.window ?? '-'].join(':');
}

/* ------------------------------------------------------------------ */
/* Dispatcher abstraction                                              */
/* ------------------------------------------------------------------ */
export interface DispatchRequest {
  /** DB job id (uuid) — also used as the BullMQ job id (dedup). */
  jobId: string;
  name: JobName;
  payload: unknown;
  /** Total attempts including the first (retries = attempts - 1). */
  attempts: number;
}

export type CancelOutcome = 'removed' | 'running' | 'not_found';

export interface JobDispatcher {
  readonly driver: 'bullmq' | 'inline';
  dispatch(req: DispatchRequest): Promise<void>;
  /** Remove a waiting/delayed job. Running jobs are cancelled cooperatively by the worker. */
  cancel(jobId: string, name: JobName): Promise<CancelOutcome>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Processor signature shared by the BullMQ worker and the inline (dev/test) dispatcher. */
export type JobProcessor = (job: { jobId: string; name: JobName; payload: unknown; attempt: number; signal: AbortSignal }) => Promise<void>;

/** Marks an error as non-retryable for BullMQ. */
export function unrecoverable(e: Error): Error {
  const u = new UnrecoverableError(e.message);
  (u as Error & { cause?: unknown }).cause = e;
  return u;
}

export function redisConnection(url: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ workers (blocking commands).
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 7 * 86400, count: 5000 },
  removeOnFail: { age: 30 * 86400 },
};

export class BullMqDispatcher implements JobDispatcher {
  readonly driver = 'bullmq' as const;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection as unknown as ConnectionOptions, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  async dispatch(req: DispatchRequest): Promise<void> {
    await this.queue(JOB_QUEUE[req.name]).add(req.name, req.payload, {
      jobId: req.jobId,
      attempts: req.attempts,
      // Exponential backoff with jitter (Master Plan §8). Retry-After is honoured inside adapters.
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
    });
  }

  async cancel(jobId: string, name: JobName): Promise<CancelOutcome> {
    const job = await this.queue(JOB_QUEUE[name]).getJob(jobId);
    if (!job) return 'not_found';
    const state = await job.getState();
    if (state === 'active') return 'running';
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') {
      await job.remove();
      return 'removed';
    }
    return 'not_found';
  }

  /** BullMQ state of a queue job, or null if it no longer exists (removed / never added / Redis data lost). */
  async state(queueJobId: string, name: JobName): Promise<string | null> {
    const job = await this.queue(JOB_QUEUE[name]).getJob(queueJobId);
    return job ? await job.getState() : null;
  }

  async ping(): Promise<void> {
    const pong = await this.connection.ping();
    if (pong !== 'PONG') throw new Error(`Unexpected Redis ping reply: ${pong}`);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/**
 * Inline dispatcher — DEV/TEST ONLY (refused in production by config validation).
 * Runs the same JobProcessor in-process, asynchronously, with the same retry semantics
 * (attempts + exponential backoff, no retry for UnrecoverableError). Lets the vertical slice
 * and E2E tests run without Redis. See ADR-0008.
 */
export class InlineDispatcher implements JobDispatcher {
  readonly driver = 'inline' as const;
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private processor: JobProcessor | null = null;

  constructor(private readonly opts: { backoffMs?: number } = {}) {}

  setProcessor(p: JobProcessor): void {
    this.processor = p;
  }

  async dispatch(req: DispatchRequest): Promise<void> {
    if (!this.processor) throw new Error('InlineDispatcher: processor not set');
    const proc = this.processor;
    const ac = new AbortController();
    this.running.set(req.jobId, ac);
    const run = (async () => {
      for (let attempt = 1; attempt <= req.attempts; attempt++) {
        try {
          await proc({ jobId: req.jobId, name: req.name, payload: req.payload, attempt, signal: ac.signal });
          return;
        } catch (e) {
          if (e instanceof UnrecoverableError || attempt === req.attempts || ac.signal.aborted) return;
          await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 50) * 2 ** (attempt - 1)));
        }
      }
    })().finally(() => {
      this.running.delete(req.jobId);
      this.pending.delete(run);
    });
    this.pending.add(run);
  }

  /** Same semantics as BullMQ for active jobs: cooperative (the processor checks the DB flag between pages). */
  async cancel(jobId: string): Promise<CancelOutcome> {
    return this.running.has(jobId) ? 'running' : 'not_found';
  }

  /** Test helper: wait until all dispatched jobs finished. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    for (const ac of this.running.values()) ac.abort(new Error('shutdown'));
    await this.drain();
  }
}
