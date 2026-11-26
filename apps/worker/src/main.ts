import { pino } from 'pino';
import { loadConfig } from '@sss/config';
import { BullMqDispatcher, type JobName } from '@sss/queue';
import { createRuntime, JobService } from '@sss/services';
import { startWorkers } from './worker.ts';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
if (config.QUEUE_DRIVER !== 'bullmq') {
  logger.error('The worker process requires QUEUE_DRIVER=bullmq (inline mode runs jobs inside the API process).');
  process.exit(1);
}
const rt = createRuntime(config, { logger });
const workers = startWorkers(rt.ctx, rt.redis!, { concurrency: config.WORKER_CONCURRENCY, jobTimeoutMs: config.JOB_TIMEOUT_SECONDS * 1000 });
logger.info({ queues: workers.map((w) => w.name), concurrency: config.WORKER_CONCURRENCY }, 'worker started');

// Startup reconciliation: DB jobs still QUEUED/RUNNING whose BullMQ job is gone or already finished
// (Redis flushed, job removed, crash between attempts) are marked FAILED/ORPHANED. Active/waiting/delayed
// BullMQ jobs are left alone (stalled ones are re-delivered by BullMQ). Jobs younger than 2 minutes are
// skipped: the API may be between creating the row and adding the queue job.
{
  const dispatcher = rt.ctx.dispatcher as BullMqDispatcher;
  const orphans = await new JobService(rt.ctx)
    .reconcileOrphans(async (j) => {
      const state = (await dispatcher.state(j.id, j.name as JobName)) ?? (await dispatcher.state(j.correlationId, j.name as JobName));
      return state !== null && state !== 'completed' && state !== 'failed' && state !== 'unknown';
    }, new Date(Date.now() - 120_000))
    .catch((e: Error) => (logger.error({ err: e.message }, 'orphan reconciliation failed'), []));
  if (orphans.length) logger.warn({ jobs: orphans }, 'marked orphaned jobs as FAILED');
}

let closing = false;
// Graceful stop requests: OS signals, or an IPC message from the native supervisor (Windows cannot
// deliver catchable signals to child processes).
const onStop = (fn: () => void) => {
  process.on('SIGINT', fn);
  process.on('SIGTERM', fn);
  process.on('message', (m: unknown) => {
    if ((m as { type?: string })?.type === 'shutdown') fn();
  });
};
{
  const sig = 'stop request';
  onStop(async () => {
    if (closing) return;
    closing = true;
    logger.info(`${sig}: graceful shutdown (finishing active jobs)`);
    await Promise.all(workers.map((w) => w.close()));
    await rt.close();
    process.exit(0);
  });
}
