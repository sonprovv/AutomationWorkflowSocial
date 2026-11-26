import { pino } from 'pino';
import { loadConfig } from '@sss/config';
import { createRuntime } from '@sss/services';
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

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    logger.info(`${sig}: graceful shutdown (finishing active jobs)`);
    await Promise.all(workers.map((w) => w.close()));
    await rt.close();
    process.exit(0);
  });
}
