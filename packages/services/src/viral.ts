import type { Prisma } from '@sss/database';
import { getEffectivePolicy, type EffectivePolicy } from '@sss/policy-engine';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { num } from './serialize.ts';

export const VIRAL_VERSION = 'viral-v1';
/** Master Plan §7.5 weights. Renormalized over the features that are available for a post. */
export const VIRAL_WEIGHTS = { velocity: 35, engagement: 20, acceleration: 20, baseline: 15, relevance: 10 } as const;
type Feature = keyof typeof VIRAL_WEIGHTS;
/** Experimental thresholds (§7.5) — must be calibrated with real data; not platform standards. */
export const VIRAL_LABELS: [number, string][] = [
  [90, 'breakout'],
  [80, 'viral'],
  [60, 'trending'],
];
const WINDOW_DAYS = 30;
const MIN_COHORT = 3;

export interface Snapshot {
  collectedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

/** Sum of the interaction counters that are present; null when none is present (never 0 for "missing"). */
export function interactions(s: Snapshot): number | null {
  const parts = [s.likes, s.comments, s.shares, s.saves].filter((x): x is number => x !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** The growth signal: views when the platform reports them, otherwise interactions. */
export function signal(s: Snapshot): { value: number | null; kind: 'views' | 'interactions' } {
  return s.views !== null ? { value: s.views, kind: 'views' } : { value: interactions(s), kind: 'interactions' };
}

/**
 * velocity = Δsignal / Δhours between the two latest snapshots; acceleration = velocity_now − velocity_previous.
 * Invalid intervals → null. A negative delta (provider correction) → null with a flag, never turned positive.
 */
export function velocityFeatures(snaps: Snapshot[]): { velocity: number | null; acceleration: number | null; flags: string[] } {
  const flags: string[] = [];
  const s = [...snaps].sort((a, b) => b.collectedAt.getTime() - a.collectedAt.getTime());
  const vel = (a: Snapshot, b: Snapshot): number | null => {
    const hours = (a.collectedAt.getTime() - b.collectedAt.getTime()) / 3600_000;
    const x = signal(a).value;
    const y = signal(b).value;
    if (hours <= 0 || x === null || y === null) return null;
    if (x < y) {
      flags.push('NEGATIVE_DELTA');
      return null;
    }
    return (x - y) / hours;
  };
  const v1 = s.length >= 2 ? vel(s[0]!, s[1]!) : null;
  const v0 = s.length >= 3 ? vel(s[1]!, s[2]!) : null;
  return { velocity: v1, acceleration: v1 !== null && v0 !== null ? v1 - v0 : null, flags };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Percentile rank 0–100 of `x` in `pop` (ties count half). */
export function percentile(x: number, pop: number[]): number {
  if (pop.length <= 1) return 50;
  const below = pop.filter((p) => p < x).length;
  const equal = pop.filter((p) => p === x).length;
  return Math.round(((below + 0.5 * (equal - 1)) / (pop.length - 1)) * 100);
}

export function followerBucket(f: number | null): string {
  if (f === null) return 'unknown';
  if (f < 1_000) return '<1k';
  if (f < 10_000) return '1k-10k';
  if (f < 100_000) return '10k-100k';
  return '100k+';
}

export interface ViralInput {
  postId: string;
  platform: string;
  contentType: string;
  followers: number | null;
  relevance: number | null;
  snapshots: Snapshot[];
}

export interface ViralResult {
  postId: string;
  status: 'SCORED' | 'INSUFFICIENT_DATA';
  score: number | null;
  label: string | null;
  features: Record<string, unknown>;
}

/**
 * Pure scoring of a set of posts (one project). Cohorts: platform × format × account size; when a cohort has
 * fewer than 3 posts the whole set is the comparison population (recorded in the features).
 */
export function scorePosts(posts: ViralInput[]): ViralResult[] {
  const raw = posts.map((p) => {
    const latest = [...p.snapshots].sort((a, b) => b.collectedAt.getTime() - a.collectedAt.getTime())[0] ?? null;
    const sig = latest ? signal(latest) : { value: null, kind: 'interactions' as const };
    const inter = latest ? interactions(latest) : null;
    const v = velocityFeatures(p.snapshots);
    let engagement: number | null = null;
    let denominator: string | null = null;
    if (inter !== null && latest?.views !== null && latest?.views !== undefined && latest.views > 0) {
      engagement = inter / latest.views;
      denominator = 'views';
    } else if (inter !== null && p.followers !== null && p.followers > 0) {
      engagement = inter / p.followers;
      denominator = 'followers';
    }
    return { p, sig, inter, engagement, denominator, ...v, cohort: `${p.platform}|${p.contentType}|${followerBucket(p.followers)}` };
  });
  const byCohort = new Map<string, typeof raw>();
  for (const r of raw) byCohort.set(r.cohort, [...(byCohort.get(r.cohort) ?? []), r]);

  return raw.map((r) => {
    const cohort = byCohort.get(r.cohort)!;
    const pop = cohort.length >= MIN_COHORT ? cohort : raw;
    const popOf = (k: 'velocity' | 'acceleration' | 'engagement') => pop.map((x) => x[k]).filter((x): x is number => x !== null);
    const base = median(pop.map((x) => x.sig.value).filter((x): x is number => x !== null));
    const norm: Record<Feature, number | null> = {
      velocity: r.velocity !== null ? percentile(r.velocity, popOf('velocity')) : null,
      acceleration: r.acceleration !== null ? percentile(r.acceleration, popOf('acceleration')) : null,
      engagement: r.engagement !== null ? percentile(r.engagement, popOf('engagement')) : null,
      baseline: r.sig.value !== null && base !== null && base > 0 && pop.length >= MIN_COHORT ? Math.min(100, Math.round(50 * (r.sig.value / base))) : null,
      relevance: r.p.relevance !== null ? Math.max(0, Math.min(100, r.p.relevance)) : null,
    };
    const available = (Object.keys(norm) as Feature[]).filter((k) => norm[k] !== null);
    const growthEvidence = available.some((k) => k === 'velocity' || k === 'engagement' || k === 'baseline');
    const features = {
      normalized: norm,
      available,
      missing: (Object.keys(norm) as Feature[]).filter((k) => norm[k] === null),
      raw: { signal: r.sig.value, signalKind: r.sig.kind, interactions: r.inter, engagementRate: r.engagement, engagementDenominator: r.denominator, velocityPerHour: r.velocity, acceleration: r.acceleration, cohortMedianSignal: base },
      cohort: { key: r.cohort, size: cohort.length, comparedWith: cohort.length >= MIN_COHORT ? 'cohort' : 'project' },
      flags: r.flags,
      weights: VIRAL_WEIGHTS,
    };
    if (available.length < 2 || !growthEvidence) return { postId: r.p.postId, status: 'INSUFFICIENT_DATA', score: null, label: null, features };
    const wSum = available.reduce((a, k) => a + VIRAL_WEIGHTS[k], 0);
    const score = Math.round((available.reduce((a, k) => a + VIRAL_WEIGHTS[k] * norm[k]!, 0) / wSum) * 10) / 10;
    return { postId: r.p.postId, status: 'SCORED', score, label: VIRAL_LABELS.find(([t]) => score >= t)?.[1] ?? null, features };
  });
}

/**
 * WF07 viral engine (Master Plan §7.5), policy-gated: only posts whose provider policy allows derived metrics
 * are scored; velocity/acceleration need stored history (allowHistoricalSnapshots). Missing features are
 * reported, never treated as 0.
 */
export class ViralService {
  constructor(private readonly ctx: ServiceContext) {}

  async scoreProject(projectId: string) {
    const { db } = this.ctx;
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
    const now = nowOf(this.ctx);
    const links = await db.projectAccount.findMany({ where: { projectId, approvalStatus: 'APPROVED' }, select: { accountId: true, relevanceScore: true } });
    const posts = await db.post.findMany({
      where: { accountId: { in: links.map((l) => l.accountId) }, status: 'AVAILABLE', sortAt: { gte: new Date(now.getTime() - WINDOW_DAYS * 86400_000) } },
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 3 }, account: { include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 } } } },
    });
    const policies = new Map<string, EffectivePolicy>();
    for (const pid of new Set(posts.map((p) => p.providerId))) policies.set(pid, await getEffectivePolicy(db, pid));
    const blocked = new Map<string, { providerId: string; policyId: string; posts: number }>();
    const allowed = posts.filter((p) => {
      const pol = policies.get(p.providerId)!;
      if (pol.allowDerivedMetrics) return true;
      const b = blocked.get(p.providerId) ?? { providerId: p.providerId, policyId: pol.policyId, posts: 0 };
      b.posts += 1;
      blocked.set(p.providerId, b);
      return false;
    });
    const relevance = new Map(links.map((l) => [l.accountId, l.relevanceScore]));
    const results = scorePosts(
      allowed.map((p) => ({
        postId: p.id,
        platform: p.platform,
        contentType: p.contentType,
        followers: num(p.account.metrics[0]?.followers ?? null),
        relevance: relevance.get(p.accountId) ?? null,
        snapshots: p.metrics.map((m) => ({ collectedAt: m.collectedAt, views: num(m.views), likes: num(m.likes), comments: num(m.comments), shares: num(m.shares), saves: num(m.saves) })),
      })),
    );
    const policyOf = new Map(allowed.map((p) => [p.id, policies.get(p.providerId)!.policyId]));
    for (const r of results) {
      const data = { status: r.status, score: r.score, label: r.label, features: r.features as Prisma.InputJsonValue, policyId: policyOf.get(r.postId)!, scoredAt: now };
      await db.viralScore.upsert({
        where: { projectId_postId_version: { projectId, postId: r.postId, version: VIRAL_VERSION } },
        create: { projectId, postId: r.postId, version: VIRAL_VERSION, ...data },
        update: data,
      });
    }
    const historyNote = [...policies.values()].some((p) => p.allowDerivedMetrics && !p.allowHistoricalSnapshots)
      ? 'Velocity/acceleration need metric history, which the provider policy does not allow: scores use engagement, baseline deviation and relevance only (weights renormalized).'
      : null;
    return {
      version: VIRAL_VERSION,
      windowDays: WINDOW_DAYS,
      postsConsidered: posts.length,
      scored: results.filter((r) => r.status === 'SCORED').length,
      insufficientData: results.filter((r) => r.status === 'INSUFFICIENT_DATA').length,
      blockedByPolicy: [...blocked.values()],
      notes: [historyNote, 'Thresholds 60/80/90 are experimental and uncalibrated.'].filter(Boolean),
    };
  }

  async list(projectId: string, limit = 50) {
    const rows = await this.ctx.db.viralScore.findMany({
      where: { projectId, version: VIRAL_VERSION },
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }],
      take: Math.min(limit, 200),
    });
    const posts = await this.ctx.db.post.findMany({ where: { id: { in: rows.map((r) => r.postId) } }, include: { account: { select: { username: true, platform: true } } } });
    const byId = new Map(posts.map((p) => [p.id, p]));
    return {
      version: VIRAL_VERSION,
      thresholds: Object.fromEntries(VIRAL_LABELS.map(([t, l]) => [l, t])),
      note: 'Experimental score from the collected sample; explain with `features`. Not a platform metric.',
      items: rows.map((r) => {
        const p = byId.get(r.postId);
        return { postId: r.postId, url: p?.url ?? null, account: p?.account.username ?? null, platform: p?.platform ?? null, publishedAt: p?.publishedAt?.toISOString() ?? null, status: r.status, score: r.score, label: r.label, features: r.features, policyId: r.policyId, scoredAt: r.scoredAt.toISOString() };
      }),
    };
  }
}
