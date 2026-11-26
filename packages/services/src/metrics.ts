import { CollectorError, toCollectorError, type MeterSnapshot } from '@sss/collector-core';
import { getProviderDescriptor } from '@sss/collector-registry';
import type { JobStatus, Prisma } from '@sss/database';
import { getEffectivePolicy } from '@sss/policy-engine';
import { nowOf, type ServiceContext } from './context.ts';
import { writePostMetric } from './persist.ts';
import { UsageGuard } from './usage.ts';

export interface MetricsRefreshOptions {
  /** One account, or null = every account tracked by a project (optionally only `projectId`). */
  accountId: string | null;
  projectId: string | null;
  jobId: string | null;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
  onProgress?: (pct: number) => Promise<void>;
  onLog?: (level: 'info' | 'warn', stage: string, message: string, data?: unknown) => Promise<void>;
  /** Defaults to METRICS_REFRESH_MAX_POSTS. */
  maxPosts?: number;
}

export interface MetricsRefreshResult {
  status: Extract<JobStatus, 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'CANCELLED' | 'SKIPPED'>;
  postsDue: number;
  postsUpdated: number;
  postsUnavailable: number;
  providers: { providerId: string; posts: number; requests: number; quotaUnits: number; error: string | null }[];
  warnings: string[];
  error: { code: string; message: string } | null;
}

const H = 3600_000;
const D = 24 * H;
/** Provider batch per transaction (adapters split further into their own API batch sizes). */
const CHUNK = 100;
/** Per-operation request cap for one provider within one refresh job. */
const PER_OPERATION_CAP = 200;

/**
 * Age-tiered refresh schedule (Master Plan §7.4): new posts often, old posts rarely.
 * Hot-content tiers (30–60 min) need viral scoring and arrive with WF07 (Phase 6).
 */
export const REFRESH_TIERS: { maxAgeMs: number; everyMs: number }[] = [
  { maxAgeMs: 2 * D, everyMs: 1 * H },
  { maxAgeMs: 7 * D, everyMs: 12 * H },
  { maxAgeMs: 30 * D, everyMs: 24 * H },
  { maxAgeMs: Number.POSITIVE_INFINITY, everyMs: 7 * D },
];

export function dueWhere(now: Date): Prisma.PostWhereInput {
  const t = now.getTime();
  const ors: Prisma.PostWhereInput[] = [{ lastMetricsAt: null }];
  let newerThan = t; // sortAt upper bound for the tier
  for (const tier of REFRESH_TIERS) {
    const olderThan = Number.isFinite(tier.maxAgeMs) ? t - tier.maxAgeMs : null;
    ors.push({
      sortAt: { ...(olderThan !== null ? { gte: new Date(olderThan) } : {}), ...(newerThan !== t ? { lt: new Date(newerThan) } : {}) },
      lastMetricsAt: { lt: new Date(t - tier.everyMs) },
    });
    if (olderThan === null) break;
    newerThan = olderThan;
  }
  return { OR: ors };
}

/**
 * Metrics refresh (WF05/WF06). Batches posts per provider through `getPostMetrics`, stores snapshots under
 * the provider policy (latest only unless history is allowed), and marks posts the provider no longer
 * returns as UNAVAILABLE (`NOT_RETURNED_BY_PROVIDER`). Network/provider errors never mark posts unavailable.
 * Each chunk commits in one transaction; a failure later keeps earlier chunks (PARTIAL_SUCCESS).
 */
export class MetricsRefreshService {
  private readonly usage: UsageGuard;

  constructor(private readonly ctx: ServiceContext) {
    this.usage = new UsageGuard(ctx);
  }

  async refresh(o: MetricsRefreshOptions): Promise<MetricsRefreshResult> {
    const { db } = this.ctx;
    const now = nowOf(this.ctx);
    const res: MetricsRefreshResult = { status: 'SUCCEEDED', postsDue: 0, postsUpdated: 0, postsUnavailable: 0, providers: [], warnings: [], error: null };
    const accountFilter: Prisma.PostWhereInput = o.accountId
      ? { accountId: o.accountId }
      : { account: { status: 'ACTIVE', projects: { some: { trackingStatus: 'TRACKING', ...(o.projectId ? { projectId: o.projectId } : {}) } } } };
    const due = await db.post.findMany({
      where: { AND: [{ status: 'AVAILABLE' }, accountFilter, dueWhere(now)] },
      orderBy: [{ lastMetricsAt: { sort: 'asc', nulls: 'first' } }, { sortAt: 'desc' }],
      take: o.maxPosts ?? this.ctx.config.METRICS_REFRESH_MAX_POSTS,
      select: { id: true, externalId: true, providerId: true, accountId: true },
    });
    res.postsDue = due.length;
    if (!due.length) {
      res.status = 'SKIPPED';
      res.warnings.push('No posts are due for a metrics refresh.');
      return res;
    }

    const byProvider = new Map<string, typeof due>();
    for (const p of due) byProvider.set(p.providerId, [...(byProvider.get(p.providerId) ?? []), p]);
    let committedChunks = 0;
    let fatal: unknown = null;
    let done = 0;

    for (const [providerId, posts] of byProvider) {
      const pr = { providerId, posts: 0, requests: 0, quotaUnits: 0, error: null as string | null };
      res.providers.push(pr);
      const provider = await db.provider.findUnique({ where: { id: providerId } });
      if (!provider?.enabled) {
        pr.error = 'POLICY_BLOCKED';
        res.warnings.push(`Provider ${providerId} is not enabled; ${posts.length} post(s) not refreshed.`);
        continue;
      }
      let meter;
      try {
        meter = await this.usage.meterFor(providerId, PER_OPERATION_CAP);
      } catch (e) {
        const ce = toCollectorError(e);
        pr.error = ce.code;
        res.warnings.push(`${providerId}: ${ce.message}`);
        continue;
      }
      const policy = await getEffectivePolicy(db, providerId);
      const adapter = getProviderDescriptor(providerId).create({ config: this.ctx.config, meter });
      const startedAt = nowOf(this.ctx);
      let providerError: CollectorError | null = null;
      try {
        for (let i = 0; i < posts.length; i += CHUNK) {
          if (await o.isCancelled?.()) {
            res.status = 'CANCELLED';
            res.warnings.push('Cancelled by user; committed batches are kept.');
            break;
          }
          const chunk = posts.slice(i, i + CHUNK);
          const metrics = await adapter.getPostMetrics(
            chunk.map((p) => p.externalId),
            o.signal,
          );
          const got = new Map(metrics.map((m) => [m.postExternalId, m]));
          const collectedAt = nowOf(this.ctx);
          let updated = 0;
          let gone = 0;
          await db.$transaction(async (tx) => {
            for (const p of chunk) {
              const m = got.get(p.externalId);
              if (m) {
                await writePostMetric(tx, p.id, m, providerId, policy);
                await tx.post.update({ where: { id: p.id }, data: { lastMetricsAt: new Date(m.collectedAt), lastCollectedAt: new Date(m.collectedAt) } });
                updated += 1;
              } else {
                // The provider answered successfully but did not return this post: deleted, private or taken
                // down (Bluesky getPosts / YouTube videos.list omit such items). Provider-confirmed, not inferred.
                const r = await tx.post.updateMany({
                  where: { id: p.id, status: 'AVAILABLE' },
                  data: { status: 'UNAVAILABLE', unavailableAt: collectedAt, unavailableReason: 'NOT_RETURNED_BY_PROVIDER', lastCollectedAt: collectedAt },
                });
                gone += r.count;
              }
            }
          });
          committedChunks += 1;
          res.postsUpdated += updated;
          res.postsUnavailable += gone;
          pr.posts += chunk.length;
          done += chunk.length;
          await o.onProgress?.(Math.round((done / due.length) * 95));
        }
      } catch (e) {
        providerError = toCollectorError(e);
        pr.error = providerError.code;
        res.error ??= { code: providerError.code, message: providerError.message };
        fatal ??= e;
      } finally {
        const snap: MeterSnapshot = meter.snapshot();
        pr.requests = snap.requests;
        pr.quotaUnits = snap.quotaUnits;
        const finishedAt = nowOf(this.ctx);
        await db.collectionRun.create({
          data: {
            jobId: o.jobId,
            providerId,
            accountId: o.accountId,
            operation: 'post.metrics_refresh',
            status: providerError ? (pr.posts > 0 ? 'PARTIAL_SUCCESS' : 'FAILED') : res.status === 'CANCELLED' ? 'CANCELLED' : 'SUCCEEDED',
            requestCount: snap.requests,
            recordCount: snap.records,
            quotaUnits: snap.quotaUnits,
            costUsd: snap.costUsd,
            latencyMs: finishedAt.getTime() - startedAt.getTime(),
            errorCode: providerError?.code ?? null,
            warnings: [],
            startedAt,
            finishedAt,
          },
        });
        await this.usage.record(providerId, snap, { projectId: o.projectId, jobId: o.jobId });
      }
      if (res.status === 'CANCELLED') break;
    }

    if (res.postsUnavailable) {
      res.warnings.push(`${res.postsUnavailable} post(s) are no longer returned by the provider and were marked UNAVAILABLE.`);
      await o.onLog?.('warn', 'unavailable', `${res.postsUnavailable} post(s) marked UNAVAILABLE (NOT_RETURNED_BY_PROVIDER)`);
    }
    const skippedProviders = res.providers.filter((p) => p.error && p.posts === 0).length;
    if (fatal || skippedProviders) {
      // Nothing committed anywhere → let the job runner apply its retry policy for transient errors.
      if (committedChunks === 0 && fatal) throw fatal;
      if (committedChunks === 0 && !fatal) {
        const code = (res.providers.find((p) => p.error)?.error ?? 'POLICY_BLOCKED') as ConstructorParameters<typeof CollectorError>[0];
        throw new CollectorError(code, res.warnings.join(' '));
      }
      if (res.status !== 'CANCELLED') res.status = 'PARTIAL_SUCCESS';
    }
    res.warnings = [...new Set(res.warnings)];
    return res;
  }
}
