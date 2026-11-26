import { z } from 'zod';
import type { Prisma, Project } from '@sss/database';
import { AppError, decodeCursor, encodeCursor, type PageResult } from '@sss/shared';
import type { ServiceContext } from './context.ts';
import { dec } from './serialize.ts';

/** project_defaults (Master Plan §9.1). Stored per project in `settings`; all user-configurable. */
export const DEFAULT_PROJECT_SETTINGS = {
  auto_track: false,
  /** Auto-track (opt-in) only approves candidates at or above this rule score… */
  auto_track_min_score: 70,
  /** …and at most this many per discovery run. */
  auto_track_max_per_run: 5,
  /** WF04: minutes between scheduled syncs of each tracked account. */
  sync_interval_minutes: 120,
  /** WF02: hours between scheduled discovery runs; 0 = off (manual only). */
  discovery_every_hours: 0,
  max_accounts: 50,
  max_keywords_per_run: 20,
  max_results_per_search: 30,
  initial_posts_per_account: 20,
  max_ai_analysis_per_day: 10,
  max_retries: 3,
  job_timeout_seconds: 600,
  on_budget_exceeded: 'pause',
  on_rate_limit: 'reschedule',
  on_provider_failure: 'alert',
} as const;

const settingsShape = {
  auto_track: z.boolean(),
  auto_track_min_score: z.number().min(0).max(100),
  auto_track_max_per_run: z.number().int().min(0).max(100),
  sync_interval_minutes: z.number().int().min(15).max(10_080),
  discovery_every_hours: z.number().int().min(0).max(720),
  max_accounts: z.number().int().min(1).max(10_000),
  max_keywords_per_run: z.number().int().min(1).max(500),
  max_results_per_search: z.number().int().min(1).max(500),
  initial_posts_per_account: z.number().int().min(1).max(200),
  max_ai_analysis_per_day: z.number().int().min(0).max(10_000),
  max_retries: z.number().int().min(0).max(10),
  job_timeout_seconds: z.number().int().min(10).max(3600),
  on_budget_exceeded: z.enum(['pause', 'alert']),
  on_rate_limit: z.enum(['reschedule', 'fail']),
  on_provider_failure: z.enum(['alert', 'ignore']),
};
/** Full, validated settings (every key present). */
export const projectSettingsSchema = z.object(settingsShape).strict();
/** User input: any subset; merged over stored settings, then over defaults. */
export const projectSettingsInputSchema = z.object(settingsShape).partial().strict();

export function mergeSettings(...layers: (object | null | undefined)[]) {
  return projectSettingsSchema.parse(Object.assign({}, DEFAULT_PROJECT_SETTINGS, ...layers.filter(Boolean)));
}

const PLATFORM = z.enum(['youtube', 'bluesky', 'tiktok', 'facebook', 'instagram', 'threads', 'reddit', 'x', 'pinterest', 'linkedin']);

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    niche: z.string().trim().max(500).nullish(),
    platforms: z.array(PLATFORM).max(10).default([]),
    languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)).max(20).default([]),
    markets: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).default([]),
    timezone: z.string().max(64).default('Asia/Ho_Chi_Minh'),
    dailyBudgetUsd: z.number().min(0).max(100_000).nullish(),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullish(),
    settings: projectSettingsInputSchema.default({}),
  })
  .strict();

export const updateProjectSchema = createProjectSchema.partial().extend({ status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional() }).strict();

export type CreateProjectInput = z.input<typeof createProjectSchema>;

export function toProjectView(p: Project & { _count?: { accounts: number } }) {
  return {
    id: p.id,
    name: p.name,
    niche: p.niche,
    platforms: p.platforms,
    languages: p.languages,
    markets: p.markets,
    timezone: p.timezone,
    dailyBudgetUsd: dec(p.dailyBudgetUsd),
    monthlyBudgetUsd: dec(p.monthlyBudgetUsd),
    settings: mergeSettings(p.settings as object),
    status: p.status,
    accountCount: p._count?.accounts ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export type ProjectView = ReturnType<typeof toProjectView>;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class ProjectService {
  constructor(private readonly ctx: ServiceContext) {}

  async create(input: unknown): Promise<ProjectView> {
    const v = createProjectSchema.parse(input);
    if (!validTimezone(v.timezone)) throw new AppError('INVALID_INPUT', `Unknown timezone: ${v.timezone}`);
    const p = await this.ctx.db.project.create({
      data: {
        name: v.name,
        niche: v.niche ?? null,
        platforms: v.platforms,
        languages: v.languages,
        markets: v.markets,
        timezone: v.timezone,
        dailyBudgetUsd: v.dailyBudgetUsd ?? 5,
        monthlyBudgetUsd: v.monthlyBudgetUsd ?? 100,
        settings: mergeSettings(v.settings) as Prisma.InputJsonValue,
      },
      include: { _count: { select: { accounts: true } } },
    });
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: 'project.create', targetType: 'project', targetId: p.id } });
    return toProjectView(p);
  }

  async list(q: { limit?: number; cursor?: string | null; status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }): Promise<PageResult<ProjectView>> {
    const limit = Math.min(q.limit ?? 50, 200);
    const c = decodeCursor(q.cursor, z.object({ t: z.string(), id: z.string() }));
    const rows = await this.ctx.db.project.findMany({
      where: {
        status: q.status,
        ...(c ? { OR: [{ createdAt: { lt: new Date(c.t) } }, { createdAt: new Date(c.t), id: { lt: c.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { _count: { select: { accounts: true } } },
    });
    const items = rows.slice(0, limit).map(toProjectView);
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items, nextCursor: last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null };
  }

  async get(id: string): Promise<ProjectView> {
    const p = await this.ctx.db.project.findUnique({ where: { id }, include: { _count: { select: { accounts: true } } } });
    if (!p) throw new AppError('NOT_FOUND', `Project ${id} not found`);
    return toProjectView(p);
  }

  async update(id: string, input: unknown): Promise<ProjectView> {
    const v = updateProjectSchema.parse(input);
    const existing = await this.ctx.db.project.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', `Project ${id} not found`);
    if (v.timezone && !validTimezone(v.timezone)) throw new AppError('INVALID_INPUT', `Unknown timezone: ${v.timezone}`);
    const settings = v.settings ? mergeSettings(existing.settings as object, v.settings) : undefined;
    const p = await this.ctx.db.project.update({
      where: { id },
      data: {
        name: v.name,
        niche: v.niche,
        platforms: v.platforms,
        languages: v.languages,
        markets: v.markets,
        timezone: v.timezone,
        dailyBudgetUsd: v.dailyBudgetUsd,
        monthlyBudgetUsd: v.monthlyBudgetUsd,
        status: v.status,
        settings: settings as Prisma.InputJsonValue | undefined,
      },
      include: { _count: { select: { accounts: true } } },
    });
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: 'project.update', targetType: 'project', targetId: id, metadata: { fields: Object.keys(v) } } });
    return toProjectView(p);
  }

  /** Deletes the project and its project-scoped links. Shared accounts/posts stay (other projects may use them). */
  async delete(id: string): Promise<void> {
    const r = await this.ctx.db.project.deleteMany({ where: { id } });
    if (r.count === 0) throw new AppError('NOT_FOUND', `Project ${id} not found`);
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: 'project.delete', targetType: 'project', targetId: id } });
  }
}
