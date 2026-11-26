import { z } from 'zod';
import type { Prisma } from '@sss/database';
import { getEffectivePolicy } from '@sss/policy-engine';
import { AppError, decodeCursor, encodeCursor, type PageResult } from '@sss/shared';
import type { ServiceContext } from './context.ts';
import { iso, num } from './serialize.ts';

export const postQuerySchema = z
  .object({
    accountId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    platform: z.string().max(20).optional(),
    contentType: z.string().max(20).optional(),
    hashtag: z.string().max(100).optional(),
    q: z.string().trim().max(200).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
    /** UNAVAILABLE posts (no longer returned by the provider) are hidden unless asked for. */
    includeUnavailable: z.preprocess((x) => x === true || x === 'true', z.boolean()).optional(),
  })
  .strict();

type PostWithMetric = Prisma.PostGetPayload<{ include: { metrics: true; account: { select: { username: true; displayName: true; platform: true } } } }>;

function metricView(m: PostWithMetric['metrics'][number] | undefined) {
  if (!m) return null;
  return {
    views: num(m.views),
    likes: num(m.likes),
    comments: num(m.comments),
    shares: num(m.shares),
    saves: num(m.saves),
    extra: m.extra,
    missing: m.missing,
    collectedAt: m.collectedAt.toISOString(),
    providerId: m.providerId,
    policyId: m.policyId,
  };
}

export function toPostView(p: PostWithMetric) {
  return {
    id: p.id,
    platform: p.platform,
    externalId: p.externalId,
    accountId: p.accountId,
    account: { username: p.account.username, displayName: p.account.displayName },
    url: p.url,
    contentType: p.contentType,
    title: p.title,
    caption: p.caption,
    hashtags: p.hashtags,
    language: p.language,
    thumbnailUrl: p.thumbnailUrl,
    durationSeconds: p.durationSeconds,
    publishedAt: iso(p.publishedAt),
    providerIndexedAt: iso(p.providerIndexedAt),
    firstSeenAt: p.firstSeenAt.toISOString(),
    status: p.status,
    unavailable: p.status === 'UNAVAILABLE' ? { since: iso(p.unavailableAt), reason: p.unavailableReason } : null,
    metrics: metricView(p.metrics[0]),
    provenance: {
      providerId: p.providerId,
      policyId: p.policyId,
      schemaVersion: p.schemaVersion,
      lastCollectedAt: p.lastCollectedAt.toISOString(),
      lastMetricsAt: iso(p.lastMetricsAt),
    },
  };
}
export type PostView = ReturnType<typeof toPostView>;

const cursorSchema = z.object({ t: z.string(), id: z.string() });

export class PostQueryService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Server-side filtered, keyset-paginated content query (Master Plan §10). */
  async list(input: unknown): Promise<PageResult<PostView>> {
    const v = postQuerySchema.parse(input);
    const c = decodeCursor(v.cursor, cursorSchema);
    const where: Prisma.PostWhereInput = {
      accountId: v.accountId,
      ...(v.includeUnavailable ? {} : { status: 'AVAILABLE' as const }),
      platform: v.platform,
      contentType: v.contentType,
      ...(v.hashtag ? { hashtags: { has: v.hashtag.toLowerCase().replace(/^#/, '') } } : {}),
      ...(v.projectId ? { account: { projects: { some: { projectId: v.projectId } } } } : {}),
      ...(v.q ? { OR: [{ caption: { contains: v.q, mode: 'insensitive' } }, { title: { contains: v.q, mode: 'insensitive' } }] } : {}),
      ...(v.since || v.until ? { sortAt: { gte: v.since ? new Date(v.since) : undefined, lte: v.until ? new Date(v.until) : undefined } } : {}),
    };
    const keyset: Prisma.PostWhereInput | undefined = c
      ? { OR: [{ sortAt: { lt: new Date(c.t) } }, { sortAt: new Date(c.t), id: { lt: c.id } }] }
      : undefined;
    const rows = await this.ctx.db.post.findMany({
      where: keyset ? { AND: [where, keyset] } : where,
      orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
      take: v.limit + 1,
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true, displayName: true, platform: true } } },
    });
    const items = rows.slice(0, v.limit).map(toPostView);
    const last = rows.length > v.limit ? rows[v.limit - 1] : null;
    return { items, nextCursor: last ? encodeCursor({ t: last.sortAt.toISOString(), id: last.id }) : null };
  }

  async get(id: string): Promise<PostView> {
    const p = await this.ctx.db.post.findUnique({
      where: { id },
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true, displayName: true, platform: true } } },
    });
    if (!p) throw new AppError('NOT_FOUND', `Post ${id} not found`);
    return toPostView(p);
  }

  /** Allowed metrics. History is only returned when the provider policy permits storing it. */
  async metrics(id: string) {
    const p = await this.ctx.db.post.findUnique({ where: { id }, select: { id: true, providerId: true } });
    if (!p) throw new AppError('NOT_FOUND', `Post ${id} not found`);
    const policy = await getEffectivePolicy(this.ctx.db, p.providerId);
    const rows = await this.ctx.db.postMetric.findMany({
      where: { postId: id },
      orderBy: { collectedAt: 'desc' },
      take: policy.allowHistoricalSnapshots ? 500 : 1,
    });
    return {
      postId: id,
      policyId: policy.policyId,
      historyAllowed: policy.allowHistoricalSnapshots,
      notice: policy.allowHistoricalSnapshots ? null : 'Provider policy does not allow storing metric history; only the latest snapshot is kept.',
      snapshots: rows.map((m) => ({
        collectedAt: m.collectedAt.toISOString(),
        views: num(m.views),
        likes: num(m.likes),
        comments: num(m.comments),
        shares: num(m.shares),
        saves: num(m.saves),
        extra: m.extra,
        missing: m.missing,
      })),
    };
  }
}
