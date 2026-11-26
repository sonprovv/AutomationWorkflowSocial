import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_QUEUE, type JobName, type QueueName } from '@sss/queue';
import { createJobProcessor, JobService, type ServiceContext } from '@sss/services';

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
    const jobs = new JobService(ctx);
    w.on('failed', (job, err) => {
      ctx.logger.warn({ queue, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job attempt failed');
      if (!job?.id) return;
      // Final failure that the processor may not have recorded (stalled too often, lock lost): make the DB
      // row terminal so it cannot stay RUNNING/QUEUED forever. No-op when the processor already finished it.
      const final = err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1) || /stalled/i.test(err.message);
      if (!final) return;
      void dbJobIdFor(ctx, job.id, job.name)
        .then((id) => (id ? jobs.failIfActive(id, /stalled/i.test(err.message) ? 'STALLED' : 'FAILED', err.message) : false))
        .catch((e: Error) => ctx.logger.error({ queue, jobId: job.id, err: e.message }, 'could not reconcile failed job'));
    });
    w.on('error', (err) => ctx.logger.error({ queue, err: err.message }, 'worker error'));
    return w;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Manual jobs use the DB id as the BullMQ id; scheduler-triggered runs are linked through correlationId. */
async function dbJobIdFor(ctx: ServiceContext, queueJobId: string, name: string): Promise<string | null> {
  if (!name.startsWith('scheduled:')) return UUID.test(queueJobId) ? queueJobId : null;
  const row = await ctx.db.job.findFirst({ where: { correlationId: queueJobId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  return row?.id ?? null;
}
