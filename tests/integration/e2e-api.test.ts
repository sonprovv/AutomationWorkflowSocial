/**
 * Phase 1 gate — "mock test end-to-end" (Master Plan §16):
 * REST API → services → real PostgreSQL → job dispatcher → processor → REAL Bluesky adapter
 * against a local fake AppView (SYNTHETIC data) → DB → REST API read-back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;

async function setup(routes: Parameters<typeof createHarness>[0], cfg: Record<string, string> = {}) {
  h = await createHarness(routes, cfg);
  app = await buildServer({ runtime: h.runtime });
}

afterEach(async () => {
  await app?.close();
  await h?.close();
});

const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

describe('E2E: project → track account by URL → sync → posts via API', () => {
  it('runs the vertical slice and is idempotent on re-sync', async () => {
    let followers = 1200;
    const feed = [fixturePost('3p3', '2026-11-25T03:00:00.000Z', 30), fixturePost('3p2', '2026-11-25T02:00:00.000Z', null), fixturePost('3p1', '2026-11-25T01:00:00.000Z', 10)];
    await setup({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile(followers) }),
      '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed } }),
    });

    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(json(ready)).toMatchObject({ status: 'ready', queueDriver: 'inline' });

    const pr = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Depth Clock Wallpaper', platforms: ['bluesky'], languages: ['en'] } });
    expect(pr.statusCode).toBe(201);
    const project = json(pr);
    expect(project.settings).toMatchObject({ auto_track: false, initial_posts_per_account: 20 });

    const tr = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com', projectId: project.id } });
    expect(tr.statusCode).toBe(201);
    const tracked = json(tr);
    expect(tracked.account).toMatchObject({ platform: 'bluesky', externalId: FIXTURE_DID, username: 'fixture.example.com' });
    expect(tracked.job_id).toBeTruthy();
    expect(tracked.status_url).toBe(`/api/v1/jobs/${tracked.job_id}`);

    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${tracked.job_id}` }));
    expect(job).toMatchObject({ status: 'SUCCEEDED', progress: 100, error: null });
    expect(job.result).toMatchObject({ mode: 'initial', postsNew: 3, postsUpdated: 0, pages: 1, profileUpdated: true });
    expect(job.logs.map((l: { stage: string }) => l.stage)).toEqual(expect.arrayContaining(['start', 'finish']));

    const posts = json(await app.inject({ method: 'GET', url: `/api/v1/posts?accountId=${tracked.account.id}` }));
    expect(posts.items.map((p: { externalId: string }) => p.externalId.split('/').pop())).toEqual(['3p3', '3p2', '3p1']);
    const [p3, p2] = posts.items;
    expect(p3.metrics).toMatchObject({ likes: 30, views: null, missing: { views: 'NOT_SUPPORTED' } });
    expect(p3.provenance).toMatchObject({ providerId: 'bluesky-appview', policyId: 'bluesky-public-v0-unverified' });
    expect(p2.metrics).toMatchObject({ likes: null, comments: null }); // missing counts stay null, never 0
    expect(p3.hashtags).toEqual(['livewallpaper']);

    const acc = json(await app.inject({ method: 'GET', url: `/api/v1/accounts/${tracked.account.id}` }));
    expect(acc.metrics).toMatchObject({ followers: 1200 });
    expect(acc.sync).toMatchObject({ backfillDone: true, watermark: '2026-11-25T03:00:00.000Z' });
    expect(acc.projects[0]).toMatchObject({ approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', lastSyncStatus: 'SUCCEEDED' });
    expect(acc.recentRuns[0]).toMatchObject({ status: 'SUCCEEDED', requests: 2, operation: 'account.sync:initial' });

    // Re-sync: one new post + changed metrics → no duplicates; policy (no history) keeps 1 snapshot per post.
    followers = 1300;
    feed.unshift(fixturePost('3p4', '2026-11-26T01:00:00.000Z', 1));
    (feed[1]!.post as { likeCount?: number }).likeCount = 99;
    const sy = await app.inject({ method: 'POST', url: `/api/v1/accounts/${tracked.account.id}/sync`, payload: { projectId: project.id } });
    expect(sy.statusCode).toBe(202);
    expect(json(sy)).toMatchObject({ status: 'QUEUED', status_url: expect.stringMatching(/^\/api\/v1\/jobs\//) });
    await h.dispatcher.drain();
    const job2 = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(sy).job_id}` }));
    expect(job2.result).toMatchObject({ mode: 'incremental', postsNew: 1, postsUpdated: 3 });
    expect(await h.db.post.count()).toBe(4);
    expect(await h.db.postMetric.count()).toBe(4); // one (latest) snapshot per post: history not allowed by policy
    const m = json(await app.inject({ method: 'GET', url: `/api/v1/posts/${p3.id}/metrics` }));
    expect(m).toMatchObject({ historyAllowed: false, snapshots: [{ likes: 99 }] });
    expect(m.snapshots).toHaveLength(1);
    expect(await h.db.accountMetric.count()).toBe(1);

    // Keyset pagination
    const page1 = json(await app.inject({ method: 'GET', url: `/api/v1/posts?limit=2` }));
    expect(page1.items).toHaveLength(2);
    const page2 = json(await app.inject({ method: 'GET', url: `/api/v1/posts?limit=2&cursor=${page1.nextCursor}` }));
    expect(page2.items.map((x: { id: string }) => x.id)).not.toContain(page1.items[0].id);
    expect(page2.nextCursor).toBeNull();
  });

  it('marks an account NOT_FOUND only on a typed provider error and fails the job without retries', async () => {
    let calls = 0;
    await setup({
      '/xrpc/app.bsky.actor.getProfile': () => {
        calls += 1;
        return calls === 1 ? { body: fixtureProfile() } : { status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } };
      },
    });
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'did:plc:fixtureauthor000000000001' } }));
    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${tr.job_id}` }));
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1, error: { code: 'NOT_FOUND' } });
    const acc = json(await app.inject({ method: 'GET', url: `/api/v1/accounts/${tr.account.id}` }));
    expect(acc.status).toBe('NOT_FOUND');
  });

  it('retries transient provider errors with backoff, then fails with the typed code; network errors never mark the account removed', async () => {
    let calls = 0;
    await setup(
      {
        '/xrpc/app.bsky.actor.getProfile': () => {
          calls += 1;
          return calls === 1 ? { body: fixtureProfile() } : { status: 503, body: {} };
        },
      },
      { MAX_RETRIES: '1' },
    );
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com' } }));
    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${tr.job_id}` }));
    expect(job).toMatchObject({ status: 'FAILED', attempts: 2, maxAttempts: 2, error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(job.logs.some((l: { stage: string }) => l.stage === 'retry')).toBe(true);
    const acc = json(await app.inject({ method: 'GET', url: `/api/v1/accounts/${tr.account.id}` }));
    expect(acc.status).toBe('ACTIVE');
    // Retry endpoint creates a new linked job
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${tr.job_id}/retry` }).then((r) => {
      expect(r.statusCode).toBe(202);
      expect(json(r).job).toMatchObject({ retryOfId: tr.job_id });
    });
    await h.dispatcher.drain();
  });

  it('keeps committed pages as PARTIAL_SUCCESS when a later page fails', async () => {
    const pages: Record<string, unknown> = {
      first: { feed: [fixturePost('3a2', '2026-11-25T02:00:00.000Z'), fixturePost('3a1', '2026-11-25T01:00:00.000Z')], cursor: 'c2' },
    };
    await setup(
      {
        '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
        '/xrpc/app.bsky.feed.getAuthorFeed': ({ url }) => (url.searchParams.get('cursor') ? { status: 403, body: { error: 'Forbidden', message: 'nope' } } : { body: pages.first }),
      },
      { INITIAL_POSTS_PER_ACCOUNT: '10' },
    );
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com' } }));
    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${tr.job_id}` }));
    expect(job).toMatchObject({ status: 'PARTIAL_SUCCESS', error: { code: 'PERMISSION_DENIED' } });
    expect(job.result).toMatchObject({ postsNew: 2, pages: 1 });
    expect(await h.db.post.count()).toBe(2);
    const cur = await h.db.syncCursor.findFirstOrThrow();
    expect(cur).toMatchObject({ backfillDone: false, cursor: 'c2' }); // checkpoint committed with page 1 only
  });

  it('dedups concurrent syncs (409) and supports cooperative cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
      '/xrpc/app.bsky.feed.getAuthorFeed': async () => {
        await gate;
        return { body: { feed: [fixturePost('3c1', '2026-11-25T01:00:00.000Z')], cursor: 'more' } };
      },
    }, { INITIAL_POSTS_PER_ACCOUNT: '50' });
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com' } }));
    // second sync while the first is active → 409 CONFLICT with the active job id
    const dup = await app.inject({ method: 'POST', url: `/api/v1/accounts/${tr.account.id}/sync` });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(json(dup).error).toMatchObject({ code: 'CONFLICT', details: { jobId: tr.job_id } });
    // cancel while running → the processor stops at the next page boundary
    const c = await app.inject({ method: 'POST', url: `/api/v1/jobs/${tr.job_id}/cancel` });
    expect(json(c)).toMatchObject({ cancelRequested: true });
    release();
    await h.dispatcher.drain();
    const job = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${tr.job_id}` }));
    expect(job.status).toBe('CANCELLED');
    expect(await h.db.post.count()).toBe(1); // page committed before cancellation is kept
    // cancelling a finished job → 409
    expect((await app.inject({ method: 'POST', url: `/api/v1/jobs/${tr.job_id}/cancel` })).statusCode).toBe(409);
  });
});

describe('E2E: provider gating and API contract', () => {
  it('lists all 10 providers; refuses blocked / not-enabled sources with explicit reasons', async () => {
    await setup({});
    const prov = json(await app.inject({ method: 'GET', url: '/api/v1/providers' }));
    expect(prov.items).toHaveLength(10);
    const byId = Object.fromEntries(prov.items.map((p: { id: string }) => [p.id, p]));
    expect(byId['bluesky-appview']).toMatchObject({ enabled: true, status: 'VERIFIED', implemented: true });
    expect(byId['youtube-data-api-v3']).toMatchObject({ enabled: false, status: 'AUTH_REQUIRED', implemented: true });
    expect(byId['tiktok-official-apis']).toMatchObject({ enabled: false, status: 'BLOCKED', implemented: false });

    const tik = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://www.tiktok.com/@somebrand' } });
    expect(tik.statusCode).toBe(422);
    expect(json(tik).error).toMatchObject({ code: 'NOT_SUPPORTED', details: { providerStatus: 'BLOCKED' } });

    const yt = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://www.youtube.com/@GoogleDevelopers' } });
    expect(yt.statusCode).toBe(403);
    expect(json(yt).error.code).toBe('POLICY_BLOCKED');

    const amb = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: '@somebody' } });
    expect(amb.statusCode).toBe(400);
  });

  it('returns the standard error envelope for validation errors, unknown routes and planned routes', async () => {
    await setup({});
    const bad = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    const tz = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'x', timezone: 'Mars/Olympus' } });
    expect(json(tz).error.code).toBe('INVALID_INPUT');
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/not-a-uuid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/nope' })).statusCode).toBe(404);
    const planned = await app.inject({ method: 'POST', url: '/api/v1/exports' });
    expect(planned.statusCode).toBe(501);
    expect(json(planned).error.message).toMatch(/Phase 5/);
    const docs = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(json(docs).paths).toHaveProperty('/api/v1/accounts');
  });

  it('project CRUD with settings merge and cascade delete of project links', async () => {
    await setup({ '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }) });
    const p = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Women Workout', settings: { max_accounts: 10 } } }));
    const up = json(await app.inject({ method: 'PATCH', url: `/api/v1/projects/${p.id}`, payload: { settings: { auto_track: true }, status: 'PAUSED' } }));
    expect(up).toMatchObject({ status: 'PAUSED', settings: { max_accounts: 10, auto_track: true } });
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com', projectId: p.id, sync: false } }));
    expect(tr.job_id).toBeNull();
    expect(await h.db.projectAccount.count()).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/projects/${p.id}` })).statusCode).toBe(204);
    expect(await h.db.projectAccount.count()).toBe(0);
    expect(await h.db.socialAccount.count()).toBe(1); // shared account data kept
    expect(await h.db.auditLog.count({ where: { action: 'project.delete' } })).toBe(1);
  });
});
