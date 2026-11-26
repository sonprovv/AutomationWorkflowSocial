import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import type { AppConfig } from '@sss/config';
import type { Prisma, Schedule } from '@sss/database';
import { idempotencyKey, JOB_NAMES } from '@sss/queue';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { enqueueDiscovery } from './discovery.ts';
import { JobService } from './jobs.ts';
import { mergeSettings } from './projects.ts';
import { iso } from './serialize.ts';

/** Workflow catalogue entries the scheduler can run (Master Plan §7.2). */
export const WORKFLOW_KEYS = [
  'WF02_MARKET_DISCOVERY',
  'WF04_NEW_POST_DETECTION',
  'WF05_POST_MONITORING',
  'WF07_VIRAL_DETECTION',
  'WF08_AI_ANALYSIS',
  'WF09_TREND_DETECTION',
  'WF11_DAILY_REPORT',
  'WF12_WEEKLY_REPORT',
  'WF13_PROVIDER_HEALTH_CHECK',
  'WF14_POLICY_CLEANUP',
  'WF15_BACKUP',
] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

export const WORKFLOW_DESCRIPTIONS: Record<WorkflowKey, string> = {
  WF02_MARKET_DISCOVERY: 'Runs discovery for projects with settings.discovery_every_hours > 0 whose last discovery is older than that.',
  WF04_NEW_POST_DETECTION: 'Queues account syncs (profile + new posts) for tracked, approved accounts whose next_sync_at is due (settings.sync_interval_minutes).',
  WF05_POST_MONITORING: 'Queues a metrics refresh for all tracked accounts; the job refreshes only posts due by age tier (WF05 hot / WF06 normal).',
  WF07_VIRAL_DETECTION: 'Scores recent posts of every ACTIVE project (viral-v1); only providers whose policy allows derived metrics are scored.',
  WF08_AI_ANALYSIS: 'Analyses the top posts with AI for projects with settings.ai_analysis_daily (needs ANTHROPIC_API_KEY; policy-gated; capped per day).',
  WF09_TREND_DETECTION: 'Computes 7-day topic signals for every ACTIVE project from the collected sample (policy-gated).',
  WF11_DAILY_REPORT: 'Builds the daily report (+ Excel) for projects with settings.daily_report and sends it to the configured channels.',
  WF12_WEEKLY_REPORT: 'Builds the weekly report for projects with settings.weekly_report and sends it to the configured channels.',
  WF13_PROVIDER_HEALTH_CHECK: 'Checks health and credentials of every enabled provider.',
  WF15_BACKUP: 'Encrypted logical backup of the database (keeps BACKUP_KEEP newest files).',
  WF14_POLICY_CLEANUP: 'Deletes data the policy says must go (provider-deleted posts after a grace period, expired retention) and purges housekeeping rows.',
};

/** Built-in schedules, created on first tick. Users can change or disable them via /workflows. */
export function builtinSchedules(config: AppConfig) {
  return [
    { id: 'wf04-account-sync', workflowKey: 'WF04_NEW_POST_DETECTION', everyMs: 5 * 60_000, cron: null, config: {} },
    { id: 'wf05-metrics-refresh', workflowKey: 'WF05_POST_MONITORING', everyMs: 60 * 60_000, cron: null, config: {} },
    { id: 'wf02-discovery', workflowKey: 'WF02_MARKET_DISCOVERY', everyMs: 60 * 60_000, cron: null, config: {} },
    { id: 'wf07-viral', workflowKey: 'WF07_VIRAL_DETECTION', everyMs: 60 * 60_000, cron: null, config: {} },
    { id: 'wf08-ai-analysis', workflowKey: 'WF08_AI_ANALYSIS', everyMs: null, cron: '0 7 * * *', config: {} },
    { id: 'wf09-trends', workflowKey: 'WF09_TREND_DETECTION', everyMs: 6 * 60 * 60_000, cron: null, config: { windowDays: 7 } },
    { id: 'wf11-daily-report', workflowKey: 'WF11_DAILY_REPORT', everyMs: null, cron: '0 6 * * *', config: {} },
    { id: 'wf12-weekly-report', workflowKey: 'WF12_WEEKLY_REPORT', everyMs: null, cron: '0 8 * * 1', config: {} },
    { id: 'wf13-provider-health', workflowKey: 'WF13_PROVIDER_HEALTH_CHECK', everyMs: config.PROVIDER_HEALTH_EVERY_MINUTES * 60_000, cron: null, config: { providerId: null } },
    { id: 'wf14-policy-cleanup', workflowKey: 'WF14_POLICY_CLEANUP', everyMs: null, cron: '0 3 * * *', config: {} },
    { id: 'wf15-backup', workflowKey: 'WF15_BACKUP', everyMs: null, cron: '0 2 * * *', config: {} },
  ] satisfies { id: string; workflowKey: WorkflowKey; everyMs: number | null; cron: string | null; config: object }[];
}

/** Next run strictly after `from`. Catch-up policy: computed from "now", so missed runs collapse into one. */
export function nextRunAfter(s: Pick<Schedule, 'cron' | 'everyMs' | 'timezone'>, from: Date): Date {
  if (s.cron) return CronExpressionParser.parse(s.cron, { currentDate: from, tz: s.timezone }).next().toDate();
  return new Date(from.getTime() + Math.max(60_000, s.everyMs ?? 3_600_000));
}

export function validCron(expr: string, tz: string): boolean {
  try {
    CronExpressionParser.parse(expr, { tz });
    return true;
  } catch {
    return false;
  }
}

export interface RunOutcome {
  status: 'ENQUEUED' | 'NOTHING_DUE' | 'SKIPPED' | 'ERROR';
  jobIds: string[];
  notes: string[];
}

export interface TickResult {
  paused: boolean;
  at: string;
  fired: { scheduleId: string; workflowKey: string; outcome: RunOutcome }[];
}

const PAUSE_KEY = 'scheduler';

export const workflowPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    everyMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
    cron: z.string().max(100).nullable().optional(),
    timezone: z.string().max(64).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const workflowCreateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,64}$/),
    workflowKey: z.enum(WORKFLOW_KEYS),
    everyMinutes: z.number().int().min(1).max(43_200).optional(),
    cron: z.string().max(100).optional(),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((v) => Boolean(v.everyMinutes) !== Boolean(v.cron), { message: 'Give exactly one of everyMinutes or cron' });

export function toWorkflowView(s: Schedule) {
  return {
    id: s.id,
    workflowKey: s.workflowKey,
    description: WORKFLOW_DESCRIPTIONS[s.workflowKey as WorkflowKey] ?? null,
    enabled: s.enabled,
    everyMinutes: s.everyMs ? Math.round(s.everyMs / 60_000) : null,
    cron: s.cron,
    timezone: s.timezone,
    config: s.config,
    nextRunAt: iso(s.nextRunAt),
    lastRunAt: iso(s.lastRunAt),
    lastStatus: s.lastStatus,
    lastResult: s.lastResult,
  };
}

/**
 * DB-driven scheduler (ADR-0012). One `tick()` per minute, from the scheduler process (BullMQ mode) or the
 * API process (inline dev mode). Each due schedule is CLAIMED with a conditional update before it runs, so two
 * tick runners can never fire the same slot twice; job idempotency keys stop duplicate work on top of that.
 */
export class SchedulerService {
  private readonly jobs: JobService;

  constructor(private readonly ctx: ServiceContext) {
    this.jobs = new JobService(ctx);
  }

  async isPaused(): Promise<boolean> {
    const s = await this.ctx.db.appSetting.findUnique({ where: { key: PAUSE_KEY } });
    return (s?.value as { paused?: boolean } | undefined)?.paused === true;
  }

  async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    await this.ctx.db.appSetting.upsert({ where: { key: PAUSE_KEY }, create: { key: PAUSE_KEY, value: { paused } }, update: { value: { paused } } });
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: paused ? 'scheduler.pause' : 'scheduler.resume', targetType: 'scheduler' } });
    return { paused };
  }

  async ensureBuiltins(now: Date = nowOf(this.ctx)): Promise<void> {
    for (const b of builtinSchedules(this.ctx.config)) {
      const exists = await this.ctx.db.schedule.findUnique({ where: { id: b.id }, select: { id: true } });
      if (exists) continue;
      const timezone = this.ctx.config.APP_TIMEZONE;
      // Interval schedules run on the first tick; cron schedules wait for their first slot.
      const nextRunAt = b.cron ? nextRunAfter({ cron: b.cron, everyMs: null, timezone }, now) : now;
      await this.ctx.db.schedule.create({ data: { ...b, timezone, enabled: true, nextRunAt } }).catch(() => {}); // concurrent creator won
    }
  }

  async tick(): Promise<TickResult> {
    const now = nowOf(this.ctx);
    const out: TickResult = { paused: false, at: now.toISOString(), fired: [] };
    if (await this.isPaused()) return { ...out, paused: true };
    await this.ensureBuiltins(now);
    const due = await this.ctx.db.schedule.findMany({ where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] }, orderBy: { nextRunAt: 'asc' } });
    for (const s of due) {
      const claimed = await this.ctx.db.schedule.updateMany({
        where: { id: s.id, enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
        data: { nextRunAt: nextRunAfter(s, now), lastRunAt: now },
      });
      if (claimed.count === 0) continue; // another runner took this slot
      const outcome = await this.runWorkflow(s).catch((e: Error): RunOutcome => ({ status: 'ERROR', jobIds: [], notes: [e.message.slice(0, 500)] }));
      await this.ctx.db.schedule.update({ where: { id: s.id }, data: { lastStatus: outcome.status, lastResult: outcome as unknown as Prisma.InputJsonValue } });
      out.fired.push({ scheduleId: s.id, workflowKey: s.workflowKey, outcome });
    }
    return out;
  }

  /** Run a schedule's workflow now (also used by POST /workflows/:id/run). */
  async runWorkflow(s: Schedule): Promise<RunOutcome> {
    switch (s.workflowKey as WorkflowKey) {
      case 'WF04_NEW_POST_DETECTION':
        return this.wf04(s);
      case 'WF05_POST_MONITORING':
        return this.single(JOB_NAMES.METRICS_REFRESH, { accountId: null, projectId: null, trigger: 'schedule' }, 'all:-', null);
      case 'WF13_PROVIDER_HEALTH_CHECK': {
        const providerId = ((s.config as { providerId?: string | null }).providerId ?? null) as string | null;
        return this.single(JOB_NAMES.PROVIDER_HEALTH, { providerId }, providerId ?? 'all', null);
      }
      case 'WF15_BACKUP':
        return this.single(JOB_NAMES.BACKUP, { trigger: 'schedule' }, 'all', null);
      case 'WF14_POLICY_CLEANUP':
        return this.single(JOB_NAMES.CLEANUP, { trigger: 'schedule' }, 'all', null);
      case 'WF02_MARKET_DISCOVERY':
        return this.wf02();
      case 'WF07_VIRAL_DETECTION':
        return this.perProject(JOB_NAMES.VIRAL, (projectId) => ({ projectId, trigger: 'schedule' }));
      case 'WF09_TREND_DETECTION': {
        const windowDays = Number((s.config as { windowDays?: number }).windowDays ?? 7);
        return this.perProject(JOB_NAMES.TRENDS, (projectId) => ({ projectId, windowDays, trigger: 'schedule' }));
      }
      case 'WF11_DAILY_REPORT':
        return this.perProject(JOB_NAMES.REPORT, (projectId) => ({ projectId, kind: 'daily', notify: true, trigger: 'schedule' }), (st) => st.daily_report === true);
      case 'WF12_WEEKLY_REPORT':
        return this.perProject(JOB_NAMES.REPORT, (projectId) => ({ projectId, kind: 'weekly', notify: true, trigger: 'schedule' }), (st) => st.weekly_report === true, 'weekly');
      case 'WF08_AI_ANALYSIS':
        if (!this.ctx.config.ANTHROPIC_API_KEY) return { status: 'SKIPPED', jobIds: [], notes: ['ANTHROPIC_API_KEY not configured'] };
        return this.perProject(JOB_NAMES.AI_ANALYZE, (projectId) => ({ projectId, postIds: null, trigger: 'schedule' }), (settings) => settings.ai_analysis_daily === true);
      default:
        return { status: 'SKIPPED', jobIds: [], notes: [`Unknown workflow ${s.workflowKey}`] };
    }
  }

  private async single(name: (typeof JOB_NAMES)[keyof typeof JOB_NAMES], payload: unknown, resource: string, projectId: string | null): Promise<RunOutcome> {
    try {
      const j = await this.jobs.create({ name, payload, idempotencyKey: idempotencyKey({ op: name, resource }), projectId, resourceType: 'schedule' });
      return { status: 'ENQUEUED', jobIds: [j.id], notes: [] };
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') return { status: 'SKIPPED', jobIds: [], notes: ['An identical job is already queued or running'] };
      throw e;
    }
  }

  /** WF03/04: due tracked accounts → account.sync, then push next_sync_at by the project's interval. */
  private async wf04(s: Schedule): Promise<RunOutcome> {
    const now = nowOf(this.ctx);
    const max = Number((s.config as { maxPerTick?: number }).maxPerTick ?? this.ctx.config.SCHEDULER_MAX_SYNCS_PER_TICK);
    const enabled = (await this.ctx.db.provider.findMany({ where: { enabled: true }, select: { id: true } })).map((p) => p.id);
    const due = await this.ctx.db.projectAccount.findMany({
      where: {
        trackingStatus: 'TRACKING',
        approvalStatus: 'APPROVED',
        project: { status: 'ACTIVE' },
        account: { status: 'ACTIVE', providerId: { in: enabled } },
        OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
      },
      orderBy: [{ nextSyncAt: { sort: 'asc', nulls: 'first' } }, { priority: 'desc' }],
      take: max,
      include: { project: { select: { settings: true } } },
    });
    if (!due.length) return { status: 'NOTHING_DUE', jobIds: [], notes: [] };
    const jobIds: string[] = [];
    const notes: string[] = [];
    for (const pa of due) {
      const interval = mergeSettings(pa.project.settings as object).sync_interval_minutes * 60_000;
      try {
        const j = await this.jobs.create({
          name: JOB_NAMES.ACCOUNT_SYNC,
          payload: { accountId: pa.accountId, projectId: pa.projectId, trigger: 'schedule' },
          idempotencyKey: idempotencyKey({ op: JOB_NAMES.ACCOUNT_SYNC, resource: pa.accountId }),
          projectId: pa.projectId,
          resourceType: 'social_account',
          resourceId: pa.accountId,
        });
        jobIds.push(j.id);
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'CONFLICT')) throw e;
        notes.push(`account ${pa.accountId}: sync already active`);
      }
      await this.ctx.db.projectAccount.update({ where: { projectId_accountId: { projectId: pa.projectId, accountId: pa.accountId } }, data: { nextSyncAt: new Date(now.getTime() + interval) } });
    }
    if (due.length === max) notes.push(`Per-tick cap ${max} reached; remaining accounts run on the next tick.`);
    return { status: jobIds.length ? 'ENQUEUED' : 'SKIPPED', jobIds, notes };
  }

  /** One job per ACTIVE project with at least one approved account (optionally filtered by settings). */
  private async perProject(name: (typeof JOB_NAMES)[keyof typeof JOB_NAMES], payload: (projectId: string) => unknown, when?: (settings: ReturnType<typeof mergeSettings>) => boolean, window?: string): Promise<RunOutcome> {
    const projects = await this.ctx.db.project.findMany({ where: { status: 'ACTIVE', accounts: { some: { approvalStatus: 'APPROVED' } } } });
    const jobIds: string[] = [];
    const notes: string[] = [];
    for (const p of projects) {
      if (when && !when(mergeSettings(p.settings as object))) continue;
      try {
        const j = await this.jobs.create({ name, payload: payload(p.id), idempotencyKey: idempotencyKey({ op: name, resource: p.id, projectId: p.id, window }), projectId: p.id, resourceType: 'project', resourceId: p.id });
        jobIds.push(j.id);
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'CONFLICT')) throw e;
        notes.push(`project ${p.id}: already running`);
      }
    }
    return { status: jobIds.length ? 'ENQUEUED' : 'NOTHING_DUE', jobIds, notes };
  }

  /** WF02: projects that opted into scheduled discovery and are due. */
  private async wf02(): Promise<RunOutcome> {
    const now = nowOf(this.ctx);
    const projects = await this.ctx.db.project.findMany({ where: { status: 'ACTIVE' } });
    const jobIds: string[] = [];
    const notes: string[] = [];
    for (const p of projects) {
      const every = mergeSettings(p.settings as object).discovery_every_hours;
      if (!every) continue;
      const last = await this.ctx.db.job.findFirst({ where: { name: JOB_NAMES.DISCOVER, projectId: p.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (last && now.getTime() - last.createdAt.getTime() < every * 3600_000) continue;
      try {
        jobIds.push((await enqueueDiscovery(this.ctx, p.id, {})).id);
      } catch (e) {
        if (e instanceof AppError && (e.code === 'CONFLICT' || e.code === 'INVALID_INPUT')) notes.push(`project ${p.id}: ${e.message}`);
        else throw e;
      }
    }
    return { status: jobIds.length ? 'ENQUEUED' : 'NOTHING_DUE', jobIds, notes };
  }

  /* ---------------- /workflows API ---------------- */

  async list() {
    await this.ensureBuiltins();
    const rows = await this.ctx.db.schedule.findMany({ orderBy: { id: 'asc' } });
    return { paused: await this.isPaused(), items: rows.map(toWorkflowView) };
  }

  async get(id: string) {
    const s = await this.ctx.db.schedule.findUnique({ where: { id } });
    if (!s) throw new AppError('NOT_FOUND', `Workflow schedule ${id} not found`);
    return s;
  }

  async create(input: unknown) {
    const v = workflowCreateSchema.parse(input);
    const timezone = v.timezone ?? this.ctx.config.APP_TIMEZONE;
    if (v.cron && !validCron(v.cron, timezone)) throw new AppError('INVALID_INPUT', `Invalid cron expression or timezone: ${v.cron} (${timezone})`);
    if (await this.ctx.db.schedule.findUnique({ where: { id: v.id } })) throw new AppError('CONFLICT', `Schedule ${v.id} already exists`);
    const base = { cron: v.cron ?? null, everyMs: v.everyMinutes ? v.everyMinutes * 60_000 : null, timezone };
    const row = await this.ctx.db.schedule.create({
      data: { id: v.id, workflowKey: v.workflowKey, ...base, enabled: v.enabled, config: v.config as Prisma.InputJsonValue, nextRunAt: nextRunAfter(base, nowOf(this.ctx)) },
    });
    return toWorkflowView(row);
  }

  async update(id: string, input: unknown) {
    const v = workflowPatchSchema.parse(input);
    const s = await this.get(id);
    const timezone = v.timezone ?? s.timezone;
    const cron = v.cron !== undefined ? v.cron : s.cron;
    const everyMs = v.everyMinutes !== undefined ? (v.everyMinutes ? v.everyMinutes * 60_000 : null) : s.everyMs;
    if (v.cron && v.everyMinutes) throw new AppError('INVALID_INPUT', 'Give either everyMinutes or cron, not both');
    if (cron && !validCron(cron, timezone)) throw new AppError('INVALID_INPUT', `Invalid cron expression or timezone: ${cron} (${timezone})`);
    if (!cron && !everyMs) throw new AppError('INVALID_INPUT', 'A schedule needs everyMinutes or cron');
    const timing = { cron: v.everyMinutes ? null : cron, everyMs: v.cron ? null : everyMs, timezone };
    const changedTiming = timing.cron !== s.cron || timing.everyMs !== s.everyMs || timing.timezone !== s.timezone;
    const row = await this.ctx.db.schedule.update({
      where: { id },
      data: {
        ...timing,
        ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
        ...(v.config ? { config: v.config as Prisma.InputJsonValue } : {}),
        ...(changedTiming || v.enabled === true ? { nextRunAt: nextRunAfter(timing, nowOf(this.ctx)) } : {}),
      },
    });
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: 'workflow.update', targetType: 'schedule', targetId: id, metadata: v as Prisma.InputJsonValue } });
    return toWorkflowView(row);
  }

  async runNow(id: string): Promise<RunOutcome> {
    const s = await this.get(id);
    const outcome = await this.runWorkflow(s);
    await this.ctx.db.schedule.update({ where: { id }, data: { lastRunAt: nowOf(this.ctx), lastStatus: outcome.status, lastResult: outcome as unknown as Prisma.InputJsonValue } });
    return outcome;
  }
}

/** Run `tick()` every SCHEDULER_TICK_SECONDS; returns a stop function. Errors are logged, never thrown. */
export function startSchedulerLoop(ctx: ServiceContext): () => void {
  const svc = new SchedulerService(ctx);
  let running = false;
  const run = async () => {
    if (running) return; // a slow tick never overlaps the next one
    running = true;
    try {
      const r = await svc.tick();
      if (r.fired.length) ctx.logger.info({ fired: r.fired.map((f) => `${f.scheduleId}:${f.outcome.status}`) }, 'scheduler tick');
    } catch (e) {
      ctx.logger.error({ err: (e as Error).message }, 'scheduler tick failed');
    } finally {
      running = false;
    }
  };
  void run();
  const t = setInterval(run, ctx.config.SCHEDULER_TICK_SECONDS * 1000);
  t.unref?.();
  return () => clearInterval(t);
}
