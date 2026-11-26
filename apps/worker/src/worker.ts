import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_QUEUE, type JobName, type QueueName } from '@sss/queue';
import { createJobProcessor, type ServiceContext } from '@sss/services';

/**
 * BullMQ workers for the queues that have processors in this phase.
 * Concurrency is per queue (Master Plan §8). Job timeout via AbortSignal; stalled-job recovery,
 * retries/backoff and dead-lettering (failed set) are handled by BullMQ.
 */
export function startWorkers(ctx: ServiceContext, connection: Redis, opts: { concurrency: number; jobTimeoutMs: number }): Worker[] {
  const processor = createJobProcessor(ctx);
  const queues = [...new Set(Object.values(JOB_QUEUE))] as QueueName[];
  return queues.map((queue) => {
    const w = new Worker(
      queue,
      async (job, _token, signal) => {
        const timeout = AbortSignal.timeout(opts.jobTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        await processor({ jobId: job.id!, name: job.name as JobName, payload: job.data, attempt: job.attemptsMade + 1, signal: combined });
      },
      {
        connection: connection.duplicate() as unknown as ConnectionOptions,
        concurrency: queue === 'collection' ? opts.concurrency : 1,
        // Lock renewal keeps long syncs from being marked stalled; stalled jobs are re-queued on restart.
        lockDuration: 60_000,
        maxStalledCount: 1,
      },
    );
    w.on('failed', (job, err) => ctx.logger.warn({ queue, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job attempt failed'));
    w.on('error', (err) => ctx.logger.error({ queue, err: err.message }, 'worker error'));
    return w;
  });
}
