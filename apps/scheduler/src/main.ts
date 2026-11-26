import { pino } from 'pino';
import { loadConfig, requireDatabaseUrl } from '@sss/config';
import { createDb } from '@sss/database';
import { BullMqDispatcher, redisConnection } from '@sss/queue';
import { syncSchedules } from './schedules.ts';

/**
 * Scheduler (Master Plan §7.1, §8): the single internal source of schedules.
 * Phase 1: registers DB-defined schedules as BullMQ Job Schedulers (idempotent upsert by schedule id,
 * so running two scheduler instances cannot create duplicate schedules). Workflow-level scheduling,
 * catch-up policy and per-account adaptive sync arrive in Phase 4.
 */
const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'scheduler' } });
const db = createDb(requireDatabaseUrl(config));
const redis = redisConnection(config.REDIS_URL);
const dispatcher = new BullMqDispatcher(redis);

async function tick() {
  try {
    const r = await syncSchedules({ db, dispatcher, config });
    logger.info(r, 'schedules synced');
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'schedule sync failed');
  }
}

await tick();
const timer = setInterval(tick, 60_000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await dispatcher.close();
    await redis.quit().catch(() => redis.disconnect());
    await db.$disconnect();
    process.exit(0);
  });
}
