import type { AppConfig } from '@sss/config';
import type { Db } from '@sss/database';
import { JOB_NAMES, type BullMqDispatcher } from '@sss/queue';

/** Built-in schedules seeded on first run (users can disable/change them in the DB; UI in Phase 4/5). */
export function defaultSchedules(config: AppConfig) {
  return [
    {
      id: 'wf13-provider-health',
      workflowKey: 'WF13_PROVIDER_HEALTH_CHECK',
      everyMs: config.PROVIDER_HEALTH_EVERY_MINUTES * 60_000,
      cron: null,
      timezone: config.APP_TIMEZONE,
      enabled: true,
      config: { providerId: null },
    },
  ];
}

const JOB_FOR_WORKFLOW: Record<string, { name: (typeof JOB_NAMES)[keyof typeof JOB_NAMES]; payload: (cfg: Record<string, unknown>) => unknown }> = {
  WF13_PROVIDER_HEALTH_CHECK: { name: JOB_NAMES.PROVIDER_HEALTH, payload: (c) => ({ providerId: (c.providerId as string | null) ?? null }) },
};

/**
 * Reconcile DB schedules → BullMQ job schedulers. Disabled/removed schedules are removed from BullMQ.
 * Scheduled executions go through the same JobService path as manual runs once the worker picks them
 * up (Phase 4 adds the DB job row + dedup for scheduled runs; Phase 1 health checks are read-only).
 */
export async function syncSchedules({ db, dispatcher, config }: { db: Db; dispatcher: BullMqDispatcher; config: AppConfig }) {
  for (const s of defaultSchedules(config)) {
    await db.schedule.upsert({ where: { id: s.id }, create: s, update: {} });
  }
  const rows = await db.schedule.findMany();
  let upserted = 0;
  let removed = 0;
  for (const s of rows) {
    const def = JOB_FOR_WORKFLOW[s.workflowKey];
    if (!def) continue;
    const queue = dispatcher.queue(def.name === JOB_NAMES.PROVIDER_HEALTH ? 'maintenance' : 'collection');
    if (!s.enabled) {
      if (await queue.removeJobScheduler(s.id)) removed += 1;
      continue;
    }
    const repeat = s.cron ? { pattern: s.cron, tz: s.timezone } : { every: s.everyMs ?? 3_600_000 };
    await queue.upsertJobScheduler(s.id, repeat, {
      name: `scheduled:${def.name}`,
      data: { scheduleId: s.id, ...((def.payload(s.config as Record<string, unknown>) as object) ?? {}) },
      opts: { attempts: 1 },
    });
    upserted += 1;
  }
  return { schedules: rows.length, upserted, removed };
}
