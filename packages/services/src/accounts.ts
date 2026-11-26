import { z } from 'zod';
import { CollectorError, PLATFORMS, type Platform } from '@sss/collector-core';
import { providerForPlatform } from '@sss/collector-registry';
import { idempotencyKey, JOB_NAMES } from '@sss/queue';
import { AppError, decodeCursor, detectPlatform, encodeCursor, type PageResult } from '@sss/shared';
import type { ServiceContext } from './context.ts';
import { JobService, toJobView, type JobView } from './jobs.ts';
import { upsertAccount } from './persist.ts';
import { iso, num } from './serialize.ts';
import { UsageGuard } from './usage.ts';

export const trackAccountSchema = z
  .object({
    input: z.string().trim().min(1).max(500),
    platform: z.enum(PLATFORMS).optional(),
    projectId: z.uuid().optional(),
    priority: z.number().int().min(0).max(100).default(0),
    /** Queue the initial sync immediately (default true). */
    sync: z.boolean().default(true),
  })
  .strict();

export const trackingPatchSchema = z
  .object({
    projectId: z.uuid(),
    trackingStatus: z.enum(['TRACKING', 'PAUSED']).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    approvalStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  })
  .strict();

type AccountRow = Awaited<ReturnType<ServiceContext['db']['socialAccount']['findUnique']>> & {};

async function latestMetrics(ctx: ServiceContext, accountId: string) {
  const m = await ctx.db.accountMetric.findFirst({ where: { accountId }, orderBy: { collectedAt: 'desc' } });
  return m
    ? {
        followers: num(m.followers),
        following: num(m.following),
        postsCount: num(m.postsCount),
        extra: m.extra,
        missing: m.missing,
        collectedAt: m.collectedAt.toISOString(),
        providerId: m.providerId,
        policyId: m.policyId,
      }
    : null;
}

export function toAccountView(a: NonNullable<AccountRow>) {
  return {
    id: a.id,
    platform: a.platform,
    externalId: a.externalId,
    username: a.username,
    displayName: a.displayName,
    profileUrl: a.profileUrl,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    accountCreatedAt: iso(a.accountCreatedAt),
    status: a.status,
    provenance: { providerId: a.providerId, policyId: a.policyId, schemaVersion: a.schemaVersion, lastCollectedAt: iso(a.lastCollectedAt) },
    firstSeenAt: a.firstSeenAt.toISOString(),
  };
}

export class AccountService {
  private readonly jobs: JobService;
  private readonly usage: UsageGuard;

  constructor(private readonly ctx: ServiceContext) {
    this.jobs = new JobService(ctx);
    this.usage = new UsageGuard(ctx);
  }

  /**
   * Resolve a URL/handle/ID with the provider (one short real call), upsert the account,
   * link it to the project (manual add = user-approved), and queue the initial sync.
   */
  async track(input: unknown): Promise<{ account: ReturnType<typeof toAccountView>; created: boolean; job: JobView | null; warnings: string[] }> {
    const v = trackAccountSchema.parse(input);
    const platform: Platform | null = v.platform ?? detectPlatform(v.input);
    if (!platform) {
      throw new AppError('INVALID_INPUT', 'Cannot detect the platform from this input; pass "platform" explicitly (e.g. for a bare @handle).');
    }
    const descriptor = providerForPlatform(platform);
    if (!descriptor) {
      const p = await this.ctx.db.provider.findFirst({ where: { platform } });
      throw new AppError('NOT_SUPPORTED', `No collector available for ${platform} (status: ${p?.status ?? 'UNKNOWN'}). See docs/feasibility/${platform}.md`, {
        platform,
        providerStatus: p?.status ?? null,
      });
    }
    const provider = await this.ctx.db.provider.findUnique({ where: { id: descriptor.providerId } });
    if (!provider?.enabled) {
      throw new AppError('POLICY_BLOCKED', `Provider ${descriptor.providerId} is not enabled (status: ${provider?.status ?? 'not seeded'}).`, {
        providerId: descriptor.providerId,
        providerStatus: provider?.status ?? null,
      });
    }
    if (v.projectId && !(await this.ctx.db.project.findUnique({ where: { id: v.projectId }, select: { id: true } }))) {
      throw new AppError('NOT_FOUND', `Project ${v.projectId} not found`);
    }
    const meter = await this.usage.meterFor(descriptor.providerId, 5);
    const adapter = descriptor.create({ config: this.ctx.config, meter });
    let resolved;
    try {
      resolved = await adapter.resolveAccount({ input: v.input });
    } finally {
      await this.usage.record(descriptor.providerId, meter.snapshot(), { projectId: v.projectId ?? null });
    }
    const { id, created } = await this.ctx.db.$transaction(async (tx) => {
      const r = await upsertAccount(tx, resolved, descriptor.providerId);
      if (v.projectId) {
        await tx.projectAccount.upsert({
          where: { projectId_accountId: { projectId: v.projectId, accountId: r.id } },
          create: { projectId: v.projectId, accountId: r.id, approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', priority: v.priority },
          update: { approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', priority: v.priority },
        });
      }
      await tx.auditLog.create({ data: { actor: 'local-user', action: 'account.track', targetType: 'social_account', targetId: r.id, metadata: { platform, projectId: v.projectId ?? null } } });
      return r;
    });
    const warnings: string[] = [];
    let job: JobView | null = null;
    if (v.sync) {
      try {
        job = toJobView(await this.enqueueSync(id, v.projectId ?? null, 'track'));
      } catch (e) {
        if (e instanceof AppError && e.code === 'CONFLICT' && typeof e.details?.jobId === 'string') {
          job = await this.jobs.get(e.details.jobId);
          warnings.push('A sync for this account is already queued or running; returning that job.');
        } else throw e;
      }
    }
    const row = await this.ctx.db.socialAccount.findUniqueOrThrow({ where: { id } });
    return { account: toAccountView(row), created, job, warnings };
  }

  async enqueueSync(accountId: string, projectId: string | null, trigger: 'track' | 'manual' | 'schedule') {
    const acc = await this.ctx.db.socialAccount.findUnique({ where: { id: accountId }, select: { id: true } });
    if (!acc) throw new AppError('NOT_FOUND', `Account ${accountId} not found`);
    return this.jobs.create({
      name: JOB_NAMES.ACCOUNT_SYNC,
      payload: { accountId, projectId, trigger },
      // No window: manual and scheduled syncs of the same account share one active-job slot.
      idempotencyKey: idempotencyKey({ op: JOB_NAMES.ACCOUNT_SYNC, resource: accountId }),
      projectId,
      resourceType: 'social_account',
      resourceId: accountId,
    });
  }

  /** Queue a metrics refresh (WF05/06) for one account, or for every tracked account (optionally one project). */
  async enqueueMetricsRefresh(accountId: string | null, projectId: string | null, trigger: 'manual' | 'schedule') {
    if (accountId) {
      const acc = await this.ctx.db.socialAccount.findUnique({ where: { id: accountId }, select: { id: true } });
      if (!acc) throw new AppError('NOT_FOUND', `Account ${accountId} not found`);
    }
    return this.jobs.create({
      name: JOB_NAMES.METRICS_REFRESH,
      payload: { accountId, projectId, trigger },
      idempotencyKey: idempotencyKey({ op: JOB_NAMES.METRICS_REFRESH, resource: accountId ?? `all:${projectId ?? '-'}` }),
      projectId,
      resourceType: accountId ? 'social_account' : 'tracked_accounts',
      resourceId: accountId ?? undefined,
    });
  }

  async get(id: string) {
    const a = await this.ctx.db.socialAccount.findUnique({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', `Account ${id} not found`);
    const [metrics, projects, cursor, runs, postCount] = await Promise.all([
      latestMetrics(this.ctx, id),
      this.ctx.db.projectAccount.findMany({ where: { accountId: id }, include: { project: { select: { name: true } } } }),
      this.ctx.db.syncCursor.findFirst({ where: { accountId: id } }),
      this.ctx.db.collectionRun.findMany({ where: { accountId: id }, orderBy: { startedAt: 'desc' }, take: 10 }),
      this.ctx.db.post.count({ where: { accountId: id } }),
    ]);
    return {
      ...toAccountView(a),
      metrics,
      postCount,
      projects: projects.map((p) => ({
        projectId: p.projectId,
        projectName: p.project.name,
        approvalStatus: p.approvalStatus,
        trackingStatus: p.trackingStatus,
        priority: p.priority,
        lastSyncAt: iso(p.lastSyncAt),
        lastSyncStatus: p.lastSyncStatus,
        nextSyncAt: iso(p.nextSyncAt),
      })),
      sync: cursor ? { backfillDone: cursor.backfillDone, watermark: iso(cursor.watermark), lastSuccessAt: iso(cursor.lastSuccessAt) } : null,
      recentRuns: runs.map((r) => ({
        id: r.id,
        jobId: r.jobId,
        operation: r.operation,
        status: r.status,
        requests: r.requestCount,
        records: r.recordCount,
        quotaUnits: r.quotaUnits,
        latencyMs: r.latencyMs,
        errorCode: r.errorCode,
        warnings: r.warnings,
        startedAt: r.startedAt.toISOString(),
        finishedAt: iso(r.finishedAt),
      })),
    };
  }

  async list(q: { projectId?: string; platform?: string; limit?: number; cursor?: string | null }): Promise<PageResult<ReturnType<typeof toAccountView> & { metrics: Awaited<ReturnType<typeof latestMetrics>> }>> {
    const limit = Math.min(q.limit ?? 50, 200);
    const c = decodeCursor(q.cursor, z.object({ t: z.string(), id: z.string() }));
    const rows = await this.ctx.db.socialAccount.findMany({
      where: {
        platform: q.platform,
        ...(q.projectId ? { projects: { some: { projectId: q.projectId } } } : {}),
        ...(c ? { OR: [{ firstSeenAt: { lt: new Date(c.t) } }, { firstSeenAt: new Date(c.t), id: { lt: c.id } }] } : {}),
      },
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map(async (a) => ({ ...toAccountView(a), metrics: await latestMetrics(this.ctx, a.id) })));
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items, nextCursor: last ? encodeCursor({ t: last.firstSeenAt.toISOString(), id: last.id }) : null };
  }

  async updateTracking(accountId: string, input: unknown) {
    const v = trackingPatchSchema.parse(input);
    const r = await this.ctx.db.projectAccount.updateMany({
      where: { accountId, projectId: v.projectId },
      data: { trackingStatus: v.trackingStatus, priority: v.priority, approvalStatus: v.approvalStatus },
    });
    if (r.count === 0) throw new AppError('NOT_FOUND', `Account ${accountId} is not linked to project ${v.projectId}`);
    await this.ctx.db.auditLog.create({ data: { actor: 'local-user', action: 'account.tracking', targetType: 'social_account', targetId: accountId, metadata: v } });
    return this.get(accountId);
  }
}

export function assertCollectorPlatform(p: string): asserts p is Platform {
  if (!(PLATFORMS as readonly string[]).includes(p)) throw new CollectorError('INVALID_INPUT', `Unknown platform ${p}`);
}
