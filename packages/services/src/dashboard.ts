import { Prisma } from '@sss/database';
import { nowOf, type ServiceContext } from './context.ts';
import { JobService } from './jobs.ts';
import { toPostView } from './posts.ts';
import { iso } from './serialize.ts';

/**
 * Dashboard overview (Master Plan §10 "Dashboard"): projects, tracked accounts, new posts, coverage,
 * usage/cost, job status. Only raw, provider-reported counts — no derived scores (those are Phase 6 and
 * policy-gated). Everything is computed server-side; the browser never loads the whole database.
 */
export class DashboardService {
  constructor(private readonly ctx: ServiceContext) {}

  async overview(projectId?: string) {
    const { db } = this.ctx;
    const now = nowOf(this.ctx);
    const d1 = new Date(now.getTime() - 86400_000);
    const d7 = new Date(now.getTime() - 7 * 86400_000);
    const d14 = new Date(now.getTime() - 14 * 86400_000);
    const postScope: Prisma.PostWhereInput = projectId ? { account: { projects: { some: { projectId } } } } : {};
    const [projects, trackedLinks, accounts, posts, new24h, new7d, unavailable, pendingCandidates, activeKeywords] = await Promise.all([
      db.project.count({ where: { status: 'ACTIVE', ...(projectId ? { id: projectId } : {}) } }),
      db.projectAccount.count({ where: { trackingStatus: 'TRACKING', approvalStatus: 'APPROVED', ...(projectId ? { projectId } : {}) } }),
      db.socialAccount.count({ where: projectId ? { projects: { some: { projectId } } } : {} }),
      db.post.count({ where: { ...postScope, status: 'AVAILABLE' } }),
      db.post.count({ where: { ...postScope, firstSeenAt: { gte: d1 } } }),
      db.post.count({ where: { ...postScope, firstSeenAt: { gte: d7 } } }),
      db.post.count({ where: { ...postScope, status: 'UNAVAILABLE' } }),
      db.discoveryCandidate.count({ where: { approvalStatus: 'PENDING', ...(projectId ? { projectId } : {}) } }),
      db.keyword.count({ where: { status: 'ACTIVE', ...(projectId ? { projectId } : {}) } }),
    ]);
    const perDay = await db.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT date_trunc('day', p.sort_at) AS day, COUNT(*) AS n
      FROM posts p
      WHERE p.sort_at >= ${d14} AND p.status = 'AVAILABLE'
      ${projectId ? Prisma.sql`AND EXISTS (SELECT 1 FROM project_accounts pa WHERE pa.account_id = p.account_id AND pa.project_id = ${projectId}::uuid)` : Prisma.empty}
      GROUP BY 1 ORDER BY 1`;
    const latest = await db.post.findMany({
      where: { ...postScope, status: 'AVAILABLE' },
      orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
      take: 6,
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true, displayName: true, platform: true } } },
    });
    // Raw public likes in the last 7 days — a plain sort, not a viral score.
    const topIds = await db.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM posts p
      JOIN LATERAL (SELECT likes FROM post_metrics m WHERE m.post_id = p.id ORDER BY m.collected_at DESC LIMIT 1) lm ON true
      WHERE p.sort_at >= ${d7} AND p.status = 'AVAILABLE' AND lm.likes IS NOT NULL
      ${projectId ? Prisma.sql`AND EXISTS (SELECT 1 FROM project_accounts pa WHERE pa.account_id = p.account_id AND pa.project_id = ${projectId}::uuid)` : Prisma.empty}
      ORDER BY lm.likes DESC LIMIT 6`;
    const topRows = await db.post.findMany({
      where: { id: { in: topIds.map((r) => r.id) } },
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true, displayName: true, platform: true } } },
    });
    const order = new Map(topIds.map((r, i) => [r.id, i]));
    topRows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    const providers = await db.provider.findMany({ orderBy: { id: 'asc' } });
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const usage = await db.usageLog.groupBy({ by: ['providerId', 'unit'], where: { day }, _sum: { quantity: true, actualCost: true } });
    const reserved = await db.usageReservation.groupBy({ by: ['providerId', 'unit'], where: { day, settledAt: null, expiresAt: { gt: now } }, _sum: { amount: true } });
    const schedules = await db.schedule.findMany({ orderBy: { nextRunAt: 'asc' } });
    const paused = ((await db.appSetting.findUnique({ where: { key: 'scheduler' } }))?.value as { paused?: boolean } | undefined)?.paused === true;
    const jobs = await new JobService(this.ctx).stats(24);

    return {
      at: now.toISOString(),
      projectId: projectId ?? null,
      counts: { projects, trackedAccounts: trackedLinks, accounts, posts, newPosts24h: new24h, newPosts7d: new7d, unavailablePosts: unavailable, pendingCandidates, activeKeywords },
      postsPerDay: perDay.map((r) => ({ day: r.day.toISOString().slice(0, 10), posts: Number(r.n) })),
      latestPosts: latest.map(toPostView),
      topPostsByLikes7d: { note: 'Sorted by raw public likes reported by the provider; not a viral score.', items: topRows.map(toPostView) },
      coverage: providers.map((p) => ({
        providerId: p.id,
        platform: p.platform,
        status: p.status,
        enabled: p.enabled,
        healthy: (p.lastHealth as { healthy?: boolean } | null)?.healthy ?? null,
        checkedAt: iso(p.checkedAt),
        usageToday: Object.fromEntries(usage.filter((u) => u.providerId === p.id).map((u) => [u.unit, u._sum.quantity ?? 0])),
        reservedToday: Object.fromEntries(reserved.filter((u) => u.providerId === p.id).map((u) => [u.unit, u._sum.amount ?? 0])),
        costTodayUsd: usage.filter((u) => u.providerId === p.id).reduce((a, u) => a + Number(u._sum.actualCost ?? 0), 0),
      })),
      scheduler: { paused, next: schedules.filter((s) => s.enabled).slice(0, 5).map((s) => ({ id: s.id, workflowKey: s.workflowKey, nextRunAt: iso(s.nextRunAt), lastStatus: s.lastStatus })) },
      jobs: { byStatus: jobs.byStatus, active: jobs.active.length, stuck: jobs.active.filter((j) => j.stuck).length, failed24h: jobs.byStatus.FAILED ?? 0 },
    };
  }
}
