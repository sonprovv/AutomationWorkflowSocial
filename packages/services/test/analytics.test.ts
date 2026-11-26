import { describe, expect, it } from 'vitest';
import { computeTopics } from '../src/trends.ts';
import { percentile, scorePosts, velocityFeatures, type Snapshot, type ViralInput } from '../src/viral.ts';

const T0 = new Date('2026-11-26T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
const snap = (h: number, likes: number | null, views: number | null = null): Snapshot => ({ collectedAt: at(h), views, likes, comments: null, shares: null, saves: null });

describe('viral-v1 features', () => {
  it('velocity and acceleration from snapshots; a negative delta is flagged, never made positive', () => {
    expect(velocityFeatures([snap(0, 10), snap(2, 30), snap(4, 70)])).toEqual({ velocity: 20, acceleration: 10, flags: [] });
    const neg = velocityFeatures([snap(0, 50), snap(2, 40)]);
    expect(neg).toMatchObject({ velocity: null, flags: ['NEGATIVE_DELTA'] });
    expect(velocityFeatures([snap(0, 10)])).toMatchObject({ velocity: null, acceleration: null });
    expect(velocityFeatures([snap(1, 10), snap(1, 20)]).velocity).toBeNull(); // zero interval is invalid
  });

  it('percentile ranks within the population', () => {
    expect(percentile(5, [1, 5, 9])).toBe(50);
    expect(percentile(9, [1, 5, 9])).toBe(100);
    expect(percentile(1, [1, 5, 9])).toBe(0);
  });
});

describe('scorePosts', () => {
  const post = (id: string, likes: number | null, followers: number | null, extra: Partial<ViralInput> = {}): ViralInput => ({
    postId: id,
    platform: 'bluesky',
    contentType: 'image',
    followers,
    relevance: null,
    snapshots: [snap(0, likes)],
    ...extra,
  });

  it('scores with the available features only (renormalized weights) and reports what is missing', () => {
    const r = scorePosts([post('a', 100, 1000, { relevance: 80 }), post('b', 10, 1000), post('c', 20, 1000), post('d', 5, 1000)]);
    const a = r.find((x) => x.postId === 'a')!;
    expect(a.status).toBe('SCORED');
    expect((a.features as any).available.sort()).toEqual(['baseline', 'engagement', 'relevance']);
    expect((a.features as any).missing.sort()).toEqual(['acceleration', 'velocity']);
    expect(a.score).toBeGreaterThan(r.find((x) => x.postId === 'd')!.score!);
    expect((a.features as any).raw.engagementDenominator).toBe('followers');
  });

  it('INSUFFICIENT_DATA when counts or denominators are missing — never scored as 0', () => {
    const r = scorePosts([post('x', null, null), post('y', 3, null)]);
    expect(r.every((x) => x.status === 'INSUFFICIENT_DATA' && x.score === null)).toBe(true);
  });

  it('labels use the experimental thresholds and views are preferred as the signal', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) =>
      post(`p${i}`, i, 100, { snapshots: [snap(0, i, i * 10), snap(-2, i, i * 5), snap(-4, i, i * 2)], relevance: 100 }),
    );
    const r = scorePosts(many);
    const top = r.find((x) => x.postId === 'p10')!;
    expect((top.features as any).raw.signalKind).toBe('views');
    // velocity 100, acceleration 100, engagement 50 (all posts share the same rate), baseline 91, relevance 100 → 88.7
    expect(top.score).toBeCloseTo(88.7, 1);
    expect(top.label).toBe('viral');
    expect(r.find((x) => x.postId === 'p1')!.label).toBeNull();
  });
});

describe('computeTopics (trends-v1)', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const p = (id: string, account: string, daysAgo: number, tags: string[], text = '') => ({
    id,
    url: `https://bsky.app/profile/x/post/${id}`,
    accountId: account,
    account,
    publishedAt: new Date(now.getTime() - daysAgo * 86400_000),
    hashtags: tags,
    text,
    interactions: 3,
  });

  it('compares equal windows, needs 2+ posts, and labels new / rising with honest confidence', () => {
    const posts = [
      p('1', 'a', 1, ['livewallpaper']),
      p('2', 'b', 2, ['livewallpaper']),
      p('3', 'c', 3, ['livewallpaper']),
      p('4', 'a', 9, ['livewallpaper']),
      p('5', 'a', 1, ['depth']),
      p('6', 'a', 2, ['depth']),
      p('7', 'a', 1, ['once']),
      p('8', 'b', 1, [], 'new Live Wallpaper drop'),
      p('9', 'c', 2, [], 'live wallpaper tips'),
    ];
    const { topics, sampleNow, samplePrev } = computeTopics(posts, ['live wallpaper'], now, 7);
    expect(sampleNow).toBe(8);
    expect(samplePrev).toBe(1);
    const lw = topics.find((t) => t.topic === '#livewallpaper')!;
    expect(lw).toMatchObject({ postsNow: 3, postsPrev: 1, accountsNow: 3, signal: 'rising', growth: 2, confidence: 'low' });
    const depth = topics.find((t) => t.topic === '#depth')!;
    expect(depth).toMatchObject({ signal: 'new', accountsNow: 1 });
    expect(depth.reasons.join(' ')).toMatch(/Single account/);
    expect(topics.find((t) => t.topic === '#once')).toBeUndefined();
    expect(topics.find((t) => t.topic === 'live wallpaper')).toMatchObject({ kind: 'keyword', postsNow: 2 });
  });
});
