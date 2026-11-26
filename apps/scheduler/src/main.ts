import { pino } from 'pino';
import { loadConfig } from '@sss/config';
import { BullMqDispatcher } from '@sss/queue';
import { createRuntime, startSchedulerLoop } from '@sss/services';

/**
 * Scheduler process (Master Plan §7.1, §8; ADR-0012): the single internal source of schedules.
 * Runs the DB-driven tick every SCHEDULER_TICK_SECONDS. Due schedules are claimed atomically in PostgreSQL,
 * so a second scheduler instance cannot fire the same slot; work is queued through BullMQ like manual runs.
 * In inline dev mode (no Redis) the API process runs the same tick instead and this process is not started.
 */
const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'scheduler' } });
if (config.QUEUE_DRIVER !== 'bullmq') {
  logger.error('The scheduler process requires QUEUE_DRIVER=bullmq (inline mode runs the tick inside the API process).');
  process.exit(1);
}
const rt = createRuntime(config, { logger });

// Phase 1 registered WF13 as a BullMQ job scheduler; the DB tick replaces it. Remove it once so health checks
// are not fired twice.
await (rt.ctx.dispatcher as BullMqDispatcher)
  .queue('maintenance')
  .removeJobScheduler('wf13-provider-health')
  .catch(() => false);

const stop = startSchedulerLoop(rt.ctx);
logger.info({ tickSeconds: config.SCHEDULER_TICK_SECONDS }, 'scheduler started');

let closing = false;
// Graceful stop requests: OS signals, or an IPC message from the native supervisor (Windows cannot
// deliver catchable signals to child processes).
const onStop = async () => {
  if (closing) return;
  closing = true;
  stop();
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', onStop);
process.on('SIGTERM', onStop);
process.on('message', (m: unknown) => {
  if ((m as { type?: string })?.type === 'shutdown') void onStop();
});
// Keep the process alive (the tick timer is unref'd).
setInterval(() => {}, 1 << 30);
