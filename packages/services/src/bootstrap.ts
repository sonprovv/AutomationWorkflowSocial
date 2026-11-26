import { join } from 'node:path';
import { credentialRefs, IMPLEMENTED_PROVIDER_IDS } from '@sss/collector-registry';
import { findRepoRoot, requireDatabaseUrl, type AppConfig } from '@sss/config';
import { createDb, seedProviders, type Db } from '@sss/database';
import { BullMqDispatcher, InlineDispatcher, redisConnection, type JobDispatcher } from '@sss/queue';
import type { Redis } from 'ioredis';
import { silentLogger, type Logger, type ServiceContext } from './context.ts';
import { createJobProcessor } from './processor.ts';

export interface Runtime {
  ctx: ServiceContext;
  redis: Redis | null;
  close(): Promise<void>;
}

/**
 * Build the service context for a process (api / worker / scheduler / cli).
 * - bullmq driver: jobs go to Redis; a separate worker process executes them.
 * - inline driver (dev/test only): jobs execute in this process via the same processor.
 */
export function createRuntime(config: AppConfig, opts: { logger?: Logger; db?: Db; dispatcher?: JobDispatcher } = {}): Runtime {
  const logger = opts.logger ?? silentLogger;
  const db = opts.db ?? createDb(requireDatabaseUrl(config));
  let redis: Redis | null = null;
  let dispatcher = opts.dispatcher;
  if (!dispatcher) {
    if (config.QUEUE_DRIVER === 'inline') {
      dispatcher = new InlineDispatcher();
    } else {
      redis = redisConnection(config.REDIS_URL);
      redis.on('error', (e) => logger.warn({ err: e.message }, 'redis connection error'));
      dispatcher = new BullMqDispatcher(redis);
    }
  }
  const ctx: ServiceContext = { db, config, dispatcher, logger };
  if (dispatcher instanceof InlineDispatcher) dispatcher.setProcessor(createJobProcessor(ctx));
  return {
    ctx,
    redis,
    async close() {
      await dispatcher!.close();
      if (redis) await redis.quit().catch(() => redis!.disconnect());
      if (!opts.db) await db.$disconnect();
    },
  };
}

/** Seed providers + effective data policies from the Phase 0 capability records. Idempotent. */
export async function seedFromCapabilityRecords(db: Db, opts: { enableUnverified?: string[] } = {}) {
  return seedProviders(db, {
    capabilitiesDir: join(findRepoRoot(), 'docs', 'feasibility', 'capabilities'),
    implemented: IMPLEMENTED_PROVIDER_IDS,
    enableUnverified: opts.enableUnverified,
    credentialRefs: credentialRefs(),
  });
}
