import type { Prisma } from '@sss/database';
import { getEffectivePolicy, type EffectivePolicy } from '@sss/policy-engine';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { normalizeKeyword } from './keywords.ts';
import { textMatches } from './scoring.ts';
import { iso, num } from './serialize.ts';
import { interactions } from './viral.ts';

export const TRENDS_VERSION = 'trends-v1';

export interface TopicSignal {
  topic: string;
  kind: 'hashtag' | 'keyword';
  postsNow: number;
  postsPrev: number;
  accountsNow: number;
  growth: number | null;
  interactionsNow: number | null;
  /** rising | new | steady | falling */
  signal: string;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  supportingPosts: { url: string; publishedAt: string | null; account: string | null }[];
}

interface PostLite {
  id: string;
  url: string;
  accountId: string;
  account: string | null;
  publishedAt: Date;
  hashtags: string[];
  text: string;
  interactions: number | null;
}

/**
 * Topic signals for two equal windows (Master Plan §7.7). Pure function: counts posts and distinct accounts per
 * hashtag / project keyword in the current vs the previous window. Confidence reflects sample size and account
 * diversity (a topic pushed by one account is never "high"). Results describe the COLLECTED sample only.
 */
export function computeTopics(posts: PostLite[], keywords: string[], now: Date, windowDays: number): { topics: TopicSignal[]; sampleNow: number; samplePrev: number } {
  const w = windowDays * 86400_000;
  const nowStart = now.getTime() - w;
  const prevStart = nowStart - w;
  const cur = posts.filter((p) => p.publishedAt.getTime() >= nowStart && p.publishedAt.getTime() <= now.getTime());
  const prev = posts.filter((p) => p.publishedAt.getTime() >= prevStart && p.publishedAt.getTime() < nowStart);
  const topicsOf = (p: PostLite): [string, 'hashtag' | 'keyword'][] => [
    ...[...new Set(p.hashtags.map((h) => normalizeKeyword(h)))].map((h): [string, 'hashtag'] => [`#${h}`, 'hashtag']),
    ...keywords.filter((k) => textMatches(p.text, k)).map((k): [string, 'keyword'] => [k, 'keyword']),
  ];
  const agg = new Map<string, { kind: 'hashtag' | 'keyword'; now: PostLite[]; prev: number }>();
  for (const p of cur) for (const [t, kind] of topicsOf(p)) agg.set(t, { kind, now: [...(agg.get(t)?.now ?? []), p], prev: agg.get(t)?.prev ?? 0 });
  for (const p of prev) for (const [t, kind] of topicsOf(p)) agg.set(t, { kind, now: agg.get(t)?.now ?? [], prev: (agg.get(t)?.prev ?? 0) + 1 });

  const topics: TopicSignal[] = [];
  for (const [topic, a] of agg) {
    const postsNow = a.now.length;
    if (postsNow < 2) continue; // a single post is not a signal
    const accountsNow = new Set(a.now.map((p) => p.accountId)).size;
    const inter = a.now.map((p) => p.interactions).filter((x): x is number => x !== null);
    const growth = a.prev > 0 ? Math.round(((postsNow - a.prev) / a.prev) * 100) / 100 : null;
    const signal = a.prev === 0 ? 'new' : postsNow >= a.prev * 1.5 ? 'rising' : postsNow <= a.prev * 0.67 ? 'falling' : 'steady';
    const reasons = [`${postsNow} post(s) from ${accountsNow} account(s) in the last ${windowDays} d vs ${a.prev} before`];
    let confidence: TopicSignal['confidence'] = 'low';
    if (postsNow >= 10 && accountsNow >= 3 && cur.length >= 50) confidence = 'medium';
    if (postsNow >= 30 && accountsNow >= 5 && cur.length >= 200) confidence = 'high';
    if (accountsNow === 1) reasons.push('Single account: could be one account posting repeatedly, not a market trend');
    if (cur.length < 50) reasons.push(`Small sample (${cur.length} posts in window)`);
    topics.push({
      topic,
      kind: a.kind,
      postsNow,
      postsPrev: a.prev,
      accountsNow,
      growth,
      interactionsNow: inter.length ? inter.reduce((x, y) => x + y, 0) : null,
      signal,
      confidence,
      reasons,
      supportingPosts: [...a.now]
        .sort((x, y) => (y.interactions ?? -1) - (x.interactions ?? -1))
        .slice(0, 5)
        .map((p) => ({ url: p.url, publishedAt: iso(p.publishedAt), account: p.account })),
    });
  }
  const order = { rising: 0, new: 1, steady: 2, falling: 3 } as Record<string, number>;
  topics.sort((x, y) => order[x.signal]! - order[y.signal]! || y.postsNow - x.postsNow || y.accountsNow - x.accountsNow);
  return { topics: topics.slice(0, 100), sampleNow: cur.length, samplePrev: prev.length };
}

/** WF09 trend engine, policy-gated (derived analytics): posts whose provider policy denies derived metrics are excluded and counted. */
export class TrendService {
  constructor(private readonly ctx: ServiceContext) {}

  async compute(projectId: string, windowDays = 7) {
    const { db } = this.ctx;
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
    const now = nowOf(this.ctx);
    const rows = await db.post.findMany({
      where: { status: 'AVAILABLE', account: { projects: { some: { projectId, approvalStatus: 'APPROVED' } } }, publishedAt: { gte: new Date(now.getTime() - 2 * windowDays * 86400_000), lte: now } },
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true } } },
    });
    const policies = new Map<string, EffectivePolicy>();
    for (const pid of new Set(rows.map((p) => p.providerId))) policies.set(pid, await getEffectivePolicy(db, pid));
    const blocked: Record<string, number> = {};
    const allowed = rows.filter((p) => (policies.get(p.providerId)!.allowDerivedMetrics ? true : ((blocked[p.providerId] = (blocked[p.providerId] ?? 0) + 1), false)));
    const keywords = (await db.keyword.findMany({ where: { projectId, status: 'ACTIVE' }, select: { normalizedText: true } })).map((k) => k.normalizedText);
    const missingMetrics = allowed.filter((p) => !p.metrics[0]).length;
    const { topics, sampleNow, samplePrev } = computeTopics(
      allowed.map((p) => {
        const m = p.metrics[0];
        return {
          id: p.id,
          url: p.url,
          accountId: p.accountId,
          account: p.account.username,
          publishedAt: p.publishedAt!,
          hashtags: p.hashtags,
          text: `${p.title ?? ''} ${p.caption ?? ''}`,
          interactions: m ? interactions({ collectedAt: m.collectedAt, views: num(m.views), likes: num(m.likes), comments: num(m.comments), shares: num(m.shares), saves: num(m.saves) }) : null,
        };
      }),
      keywords,
      now,
      windowDays,
    );
    const coverage = {
      scope: 'Collected sample of the project’s approved accounts only — not representative of the whole platform.',
      providers: [...new Set(allowed.map((p) => p.providerId))],
      blockedByPolicy: Object.entries(blocked).map(([providerId, posts]) => ({ providerId, posts, reason: 'Derived analytics not allowed by the provider policy' })),
      postsWithoutMetrics: missingMetrics,
      samplePrev,
    };
    const snap = await db.trendSnapshot.create({
      data: { projectId, windowDays, version: TRENDS_VERSION, sampleSize: sampleNow, topics: topics as unknown as Prisma.InputJsonValue, coverage: coverage as Prisma.InputJsonValue, computedAt: now },
    });
    return { id: snap.id, version: TRENDS_VERSION, windowDays, sampleSize: sampleNow, topics: topics.length, coverage };
  }

  async latest(projectId: string) {
    const s = await this.ctx.db.trendSnapshot.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } });
    if (!s) return null;
    return { id: s.id, version: s.version, windowDays: s.windowDays, sampleSize: s.sampleSize, computedAt: s.computedAt.toISOString(), topics: s.topics, coverage: s.coverage };
  }
}
