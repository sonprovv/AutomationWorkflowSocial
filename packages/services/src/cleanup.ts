import { nowOf, type ServiceContext } from './context.ts';
import { UsageGuard } from './usage.ts';

export interface CleanupResult {
  status: 'SUCCEEDED';
  unavailablePostsDeleted: number;
  retention: { policyId: string; providerId: string; retentionDays: number | null; postsDeleted: number; note: string | null }[];
  stalePosts: { policyId: string; refreshDays: number; posts: number }[];
  reservationsPurged: number;
  jobLogsPurged: number;
  searchResultsPurged: number;
  warnings: string[];
}

const DAY = 86400_000;
const JOB_LOG_DAYS = 30;
const SEARCH_RESULT_DAYS = 90;

/**
 * WF14 policy cleanup & housekeeping (Master Plan §7.2, §9.2):
 *  - posts the provider stopped returning (UNAVAILABLE) are deleted after a grace period, with their metrics
 *    (Bluesky Developer Guidelines: honour deletions). Configurable; counts only go to the audit log.
 *  - posts past the policy `retentionDays` are deleted. When retention is unknown (null, policy not yet
 *    approved) nothing is deleted and the result says so — deny-by-default never silently destroys data.
 *  - posts older than `refreshDays` without a refresh are reported (the metrics refresh job renews them).
 *  - old usage reservations, terminal-job logs and search hits are purged.
 */
export class CleanupService {
  constructor(private readonly ctx: ServiceContext) {}

  async run(): Promise<CleanupResult> {
    const { db, config } = this.ctx;
    const now = nowOf(this.ctx);
    const res: CleanupResult = { status: 'SUCCEEDED', unavailablePostsDeleted: 0, retention: [], stalePosts: [], reservationsPurged: 0, jobLogsPurged: 0, searchResultsPurged: 0, warnings: [] };

    if (config.CLEANUP_DELETE_UNAVAILABLE) {
      const cutoff = new Date(now.getTime() - config.CLEANUP_UNAVAILABLE_GRACE_HOURS * 3600_000);
      res.unavailablePostsDeleted = (await db.post.deleteMany({ where: { status: 'UNAVAILABLE', unavailableAt: { lt: cutoff } } })).count;
    } else {
      res.warnings.push('CLEANUP_DELETE_UNAVAILABLE=false: posts the provider no longer returns are kept (hidden from the API).');
    }

    for (const p of await db.dataPolicy.findMany()) {
      if (p.retentionDays === null) {
        const n = await db.post.count({ where: { policyId: p.id } });
        res.retention.push({ policyId: p.id, providerId: p.providerId, retentionDays: null, postsDeleted: 0, note: n ? `Retention not verified for this policy; ${n} post(s) kept pending Product Owner approval` : null });
      } else {
        const cutoff = new Date(now.getTime() - p.retentionDays * DAY);
        const r = await db.post.deleteMany({ where: { policyId: p.id, lastCollectedAt: { lt: cutoff } } });
        res.retention.push({ policyId: p.id, providerId: p.providerId, retentionDays: p.retentionDays, postsDeleted: r.count, note: null });
      }
      if (p.refreshDays !== null) {
        const posts = await db.post.count({ where: { policyId: p.id, status: 'AVAILABLE', lastCollectedAt: { lt: new Date(now.getTime() - p.refreshDays * DAY) } } });
        if (posts) res.stalePosts.push({ policyId: p.id, refreshDays: p.refreshDays, posts });
      }
    }

    res.reservationsPurged = await new UsageGuard(this.ctx).purgeReservations(7);
    res.jobLogsPurged = (
      await db.jobLog.deleteMany({ where: { ts: { lt: new Date(now.getTime() - JOB_LOG_DAYS * DAY) }, job: { status: { notIn: ['QUEUED', 'RUNNING'] } } } })
    ).count;
    res.searchResultsPurged = (await db.searchResult.deleteMany({ where: { collectedAt: { lt: new Date(now.getTime() - SEARCH_RESULT_DAYS * DAY) } } })).count;

    await db.auditLog.create({
      data: {
        actor: 'system',
        action: 'cleanup.run',
        targetType: 'system',
        metadata: {
          unavailablePostsDeleted: res.unavailablePostsDeleted,
          retentionDeleted: res.retention.reduce((a, r) => a + r.postsDeleted, 0),
          reservationsPurged: res.reservationsPurged,
          jobLogsPurged: res.jobLogsPurged,
          searchResultsPurged: res.searchResultsPurged,
        },
      },
    });
    return res;
  }
}
