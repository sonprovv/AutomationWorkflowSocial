import { CollectorError, toCollectorError, type MeterSnapshot, type Post, type RequestLogEntry } from '@sss/collector-core';
import { getProviderDescriptor } from '@sss/collector-registry';
import type { JobStatus } from '@sss/database';
import { getEffectivePolicy } from '@sss/policy-engine';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { upsertAccount, upsertPost } from './persist.ts';
import { UsageGuard } from './usage.ts';

export interface SyncOptions {
  accountId: string;
  projectId: string | null;
  jobId: string | null;
  signal?: AbortSignal;
  /** Cooperative cancellation check between pages. */
  isCancelled?: () => Promise<boolean>;
  onProgress?: (pct: number) => Promise<void>;
  onLog?: (level: 'info' | 'warn', stage: string, message: string, data?: unknown) => Promise<void>;
}

export interface SyncResult {
  status: Extract<JobStatus, 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'CANCELLED'>;
  mode: 'initial' | 'incremental';
  pages: number;
  postsSeen: number;
  postsNew: number;
  postsUpdated: number;
  profileUpdated: boolean;
  watermark: string | null;
  usage: Pick<MeterSnapshot, 'requests' | 'quotaUnits' | 'records'>;
  warnings: string[];
  error: { code: string; message: string } | null;
}

/** Overlap window for incremental sync: re-read posts this much older than the watermark (pins, edits, late data). */
const OVERLAP_MS = 24 * 3600_000;
const PAGE_SIZE = 25;
const MAX_PAGES = 10;

/**
 * Account sync pipeline (Master Plan §5.2, §7.4):
 * check provider/policy/quota → fetch profile → page through newest posts → per page: upsert posts +
 * allowed metrics AND checkpoint in ONE transaction → stop when caught up → record run + usage.
 * Partial success keeps committed pages. Typed NOT_FOUND / PRIVATE_OR_REMOVED mark the account status;
 * network errors never do.
 */
export class SyncService {
  private readonly usage: UsageGuard;

  constructor(private readonly ctx: ServiceContext) {
    this.usage = new UsageGuard(ctx);
  }

  async syncAccount(o: SyncOptions): Promise<SyncResult> {
    const { db, config } = this.ctx;
    const account = await db.socialAccount.findUnique({ where: { id: o.accountId } });
    if (!account) throw new AppError('NOT_FOUND', `Account ${o.accountId} not found`);
    const provider = await db.provider.findUnique({ where: { id: account.providerId } });
    if (!provider?.enabled) {
      throw new CollectorError('POLICY_BLOCKED', `Provider ${account.providerId} is not enabled (status ${provider?.status ?? 'unknown'}; Phase 0 gate)`);
    }
    const descriptor = getProviderDescriptor(account.providerId);
    const policy = await getEffectivePolicy(db, account.providerId);
    const meter = await this.usage.meterFor(account.providerId, 60);
    const requestLog: RequestLogEntry[] = [];
    const adapter = descriptor.create({ config, meter, onLog: (e) => requestLog.push(e) });

    const cursorRow = await db.syncCursor.findUnique({ where: { accountId_providerId: { accountId: account.id, providerId: account.providerId } } });
    const mode: SyncResult['mode'] = cursorRow?.backfillDone ? 'incremental' : 'initial';
    const limit = config.INITIAL_POSTS_PER_ACCOUNT;
    const startedAt = nowOf(this.ctx);
    const res: SyncResult = {
      status: 'SUCCEEDED',
      mode,
      pages: 0,
      postsSeen: 0,
      postsNew: 0,
      postsUpdated: 0,
      profileUpdated: false,
      watermark: cursorRow?.watermark?.toISOString() ?? null,
      usage: { requests: 0, quotaUnits: 0, records: 0 },
      warnings: [],
      error: null,
    };
    let caughtError: unknown = null;

    try {
      // 1) Profile
      const profile = await adapter.getProfile(account.externalId, o.signal);
      await db.$transaction(async (tx) => {
        await upsertAccount(tx, profile, account.providerId);
      });
      res.profileUpdated = true;
      await o.onProgress?.(10);

      // 2) Posts, newest first
      let cursor: string | null = null;
      let watermark = cursorRow?.watermark ?? null;
      const stopBefore = mode === 'incremental' && watermark ? new Date(watermark.getTime() - OVERLAP_MS) : null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (await o.isCancelled?.()) {
          res.status = 'CANCELLED';
          res.warnings.push('Cancelled by user; committed pages are kept.');
          break;
        }
        const want = mode === 'initial' ? Math.min(PAGE_SIZE, limit - res.postsSeen) : PAGE_SIZE;
        if (want <= 0) break;
        const p = await adapter.listPosts({ accountExternalId: account.externalId, limit: want, cursor, signal: o.signal });
        res.warnings.push(...p.warnings);
        const posts: Post[] = mode === 'initial' ? p.items.slice(0, limit - res.postsSeen) : p.items;
        const newest = maxDate(posts.map((x) => x.publishedAt));
        if (newest && (!watermark || newest > watermark)) watermark = newest;
        const nextCursor = p.nextCursor;
        // Page data + checkpoint commit atomically: a crash can never advance the checkpoint past unsaved data.
        await db.$transaction(async (tx) => {
          for (const post of posts) {
            const r = await upsertPost(tx, post, account.id, account.providerId, policy);
            if (r.created) res.postsNew += 1;
            else res.postsUpdated += 1;
          }
          await tx.syncCursor.upsert({
            where: { accountId_providerId: { accountId: account.id, providerId: account.providerId } },
            create: { accountId: account.id, providerId: account.providerId, cursor: mode === 'initial' ? nextCursor : null, watermark },
            update: { cursor: mode === 'initial' ? nextCursor : cursorRow?.cursor ?? null, watermark },
          });
        });
        res.pages = page;
        res.postsSeen += posts.length;
        await o.onProgress?.(10 + Math.min(85, Math.round((res.postsSeen / Math.max(limit, 1)) * 85)));
        if (!nextCursor) break;
        if (mode === 'initial' && res.postsSeen >= limit) break;
        if (stopBefore && posts.some((x) => x.publishedAt && new Date(x.publishedAt) < stopBefore)) break; // caught up
        cursor = nextCursor;
      }
      res.watermark = watermark?.toISOString() ?? null;
      if (res.status !== 'CANCELLED') {
        await db.syncCursor.update({
          where: { accountId_providerId: { accountId: account.id, providerId: account.providerId } },
          data: { backfillDone: true, lastSuccessAt: nowOf(this.ctx), cursor: null },
        }).catch(async () => {
          // Account with zero posts: create the cursor row now.
          await db.syncCursor.create({ data: { accountId: account.id, providerId: account.providerId, backfillDone: true, lastSuccessAt: nowOf(this.ctx) } });
        });
      }
    } catch (e) {
      caughtError = e;
      const ce = toCollectorError(e);
      res.error = { code: ce.code, message: ce.message };
      if (!res.profileUpdated && (ce.code === 'NOT_FOUND' || ce.code === 'PRIVATE_OR_REMOVED')) {
        // Provider-confirmed (typed) unavailability — never inferred from network errors.
        await db.socialAccount.update({ where: { id: account.id }, data: { status: ce.code } });
      }
      if (res.pages > 0 || res.profileUpdated) res.status = 'PARTIAL_SUCCESS';
    } finally {
      const snap = meter.snapshot();
      res.usage = { requests: snap.requests, quotaUnits: snap.quotaUnits, records: snap.records };
      res.warnings = [...new Set(res.warnings)];
      const finishedAt = nowOf(this.ctx);
      await db.collectionRun.create({
        data: {
          jobId: o.jobId,
          providerId: account.providerId,
          accountId: account.id,
          operation: `account.sync:${mode}`,
          status: caughtError && res.status === 'SUCCEEDED' ? 'FAILED' : res.status,
          requestCount: snap.requests,
          recordCount: snap.records,
          quotaUnits: snap.quotaUnits,
          costUsd: snap.costUsd,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
          errorCode: res.error?.code ?? null,
          warnings: res.warnings.slice(0, 50),
          startedAt,
          finishedAt,
        },
      });
      await this.usage.record(account.providerId, snap, { projectId: o.projectId, jobId: o.jobId });
      if (o.projectId) {
        await db.projectAccount.updateMany({
          where: { projectId: o.projectId, accountId: account.id },
          data: { lastSyncAt: finishedAt, lastSyncStatus: caughtError && res.status === 'SUCCEEDED' ? 'FAILED' : res.status },
        });
      }
      if (requestLog.length) {
        const errors = requestLog.filter((r) => r.errorCode).map((r) => `${r.errorCode}@${r.url}`);
        await o.onLog?.('info', 'requests', `${requestLog.length} provider request(s)`, { errors: errors.slice(0, 10) });
      }
    }
    // Nothing committed at all → propagate so the job runner applies retry policy.
    if (caughtError && res.status === 'SUCCEEDED') throw caughtError;
    return res;
  }
}

function maxDate(xs: (string | null)[]): Date | null {
  let m: Date | null = null;
  for (const x of xs) {
    if (!x) continue;
    const d = new Date(x);
    if (!Number.isNaN(d.getTime()) && (!m || d > m)) m = d;
  }
  return m;
}
