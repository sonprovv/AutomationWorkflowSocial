/**
 * Phase 2 — metrics refresh (WF05/06): age-tiered due-ness, policy-bound snapshots, provider-confirmed
 * unavailability. REAL services + Postgres + REAL Bluesky adapter against a fake AppView (SYNTHETIC data).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

async function trackedWithPosts(getPosts: Parameters<typeof createHarness>[0][string], feed = [fixturePost('3m3', recent(3), 30), fixturePost('3m2', recent(4), 20), fixturePost('3m1', recent(5), 10)]) {
  h = await createHarness({
    '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
    '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed } }),
    '/xrpc/app.bsky.feed.getPosts': getPosts,
  });
  app = await buildServer({ runtime: h.runtime });
  const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Metrics refresh', platforms: ['bluesky'] } }));
  const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id } }));
  await h.dispatcher.drain();
  return { projectId: pr.id as string, accountId: tr.account.id as string, feed };
}

async function runRefresh(url: string, payload: object = {}) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode).toBe(202);
  await h.dispatcher.drain();
  return json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(r).job_id}` }));
}

/** Make every post overdue. */
const makeOverdue = () => h.db.post.updateMany({ data: { lastMetricsAt: new Date(Date.now() - 2 * 3600_000) } });

describe('metrics refresh (WF05/06)', () => {
  it('updates due posts, keeps one snapshot under the no-history policy, and marks posts the provider no longer returns UNAVAILABLE', async () => {
    let calls = 0;
    const { accountId, feed } = await trackedWithPosts(({ url }) => {
      calls += 1;
      const uris = url.searchParams.getAll('uris');
      // 3m1 deleted on the platform: getPosts silently omits it.
      const posts = feed.map((f) => f.post).filter((p) => uris.includes(p.uri) && !p.uri.endsWith('/3m1'));
      return { body: { posts: posts.map((p) => ({ ...p, likeCount: (p.likeCount ?? 0) + 100 })) } };
    });
    // Just synced → nothing due yet.
    const skipped = await runRefresh(`/api/v1/accounts/${accountId}/refresh-metrics`);
    expect(skipped).toMatchObject({ status: 'SKIPPED' });
    expect(calls).toBe(0);

    await makeOverdue();
    const job = await runRefresh(`/api/v1/accounts/${accountId}/refresh-metrics`);
    expect(job).toMatchObject({ status: 'SUCCEEDED', error: null });
    expect(job.result).toMatchObject({ postsDue: 3, postsUpdated: 2, postsUnavailable: 1, providers: [{ providerId: 'bluesky-appview', posts: 3, requests: 1 }] });
    expect(calls).toBe(1); // one batched getPosts call for 3 posts

    const visible = json(await app.inject({ method: 'GET', url: `/api/v1/posts?accountId=${accountId}` }));
    expect(visible.items.map((p: { externalId: string }) => p.externalId.split('/').pop())).toEqual(['3m3', '3m2']);
    expect(visible.items[0].metrics).toMatchObject({ likes: 130 });
    expect(visible.items[0].provenance.lastMetricsAt).toBeTruthy();
    const all = json(await app.inject({ method: 'GET', url: `/api/v1/posts?accountId=${accountId}&includeUnavailable=true` }));
    expect(all.items.find((p: { externalId: string }) => p.externalId.endsWith('/3m1'))).toMatchObject({
      status: 'UNAVAILABLE',
      unavailable: { reason: 'NOT_RETURNED_BY_PROVIDER', since: expect.any(String) },
    });
    expect(await h.db.postMetric.count()).toBe(3); // latest snapshot only (history not allowed by policy)

    // The post comes back in the feed on the next sync → AVAILABLE again.
    await app.inject({ method: 'POST', url: `/api/v1/accounts/${accountId}/sync`, payload: {} });
    await h.dispatcher.drain();
    expect(await h.db.post.count({ where: { status: 'UNAVAILABLE' } })).toBe(0);
  });

  it('never marks posts unavailable on a provider error; fails with the typed code after retries', async () => {
    const { accountId } = await trackedWithPosts(() => ({ status: 503, body: { error: 'InternalServerError', message: 'down' } }));
    await makeOverdue();
    const job = await runRefresh(`/api/v1/accounts/${accountId}/refresh-metrics`);
    expect(job).toMatchObject({ status: 'FAILED', error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(await h.db.post.count({ where: { status: 'UNAVAILABLE' } })).toBe(0);
  });

  it('refreshes all tracked accounts, skips untracked ones, and dedups concurrent refresh requests', async () => {
    const { accountId, projectId, feed } = await trackedWithPosts(({ url }) => ({
      body: { posts: feed.map((f) => f.post).filter((p) => url.searchParams.getAll('uris').includes(p.uri)) },
    }));
    await makeOverdue();
    await app.inject({ method: 'PATCH', url: `/api/v1/accounts/${accountId}/tracking`, payload: { projectId, trackingStatus: 'PAUSED' } });
    const paused = await runRefresh('/api/v1/metrics/refresh');
    expect(paused).toMatchObject({ status: 'SKIPPED' });

    await app.inject({ method: 'PATCH', url: `/api/v1/accounts/${accountId}/tracking`, payload: { projectId, trackingStatus: 'TRACKING' } });
    const first = await app.inject({ method: 'POST', url: '/api/v1/metrics/refresh', payload: { projectId } });
    const second = await app.inject({ method: 'POST', url: '/api/v1/metrics/refresh', payload: { projectId } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(first).job_id}` }));
    expect(job.result).toMatchObject({ postsDue: 3, postsUpdated: 3, postsUnavailable: 0 });
  });

  it('uses age tiers: a 10-day-old post refreshed 13 h ago is not due, a 1-day-old one refreshed 2 h ago is', async () => {
    const { accountId } = await trackedWithPosts(
      ({ url }) => ({ body: { posts: [fixturePost('3new', recent(24)), fixturePost('3old', recent(240))].map((f) => f.post).filter((p) => url.searchParams.getAll('uris').includes(p.uri)) } }),
      [fixturePost('3new', recent(24)), fixturePost('3old', recent(240))],
    );
    await h.db.post.updateMany({ where: { externalId: { endsWith: '/3new' } }, data: { lastMetricsAt: new Date(Date.now() - 2 * 3600_000) } });
    await h.db.post.updateMany({ where: { externalId: { endsWith: '/3old' } }, data: { lastMetricsAt: new Date(Date.now() - 13 * 3600_000) } });
    const job = await runRefresh(`/api/v1/accounts/${accountId}/refresh-metrics`);
    expect(job.result).toMatchObject({ postsDue: 1, postsUpdated: 1 });
  });
});
