import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createJobProcessor, JobService, AccountService } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

describe('database encoding & search (regression: WIN1252 default on Windows)', () => {
  it('stores emoji / Vietnamese / CJK text and case-folds Vietnamese in search', async () => {
    const text = 'Hình nền ĐỘNG 3D cực đẹp 😍🔥 动态壁纸 #HìnhNền';
    h = await createHarness({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: { ...fixtureProfile(), displayName: 'Thương hiệu 🚀', description: '壁纸 brand' } }),
      '/xrpc/app.bsky.feed.getAuthorFeed': () => ({
        body: { feed: [{ post: { uri: `at://${FIXTURE_DID}/app.bsky.feed.post/3u1`, cid: 'c', author: { did: FIXTURE_DID, handle: 'fixture.example.com' }, record: { text, createdAt: '2026-11-25T00:00:00Z', langs: ['vi'] }, likeCount: 1 } }] },
      }),
    });
    app = await buildServer({ runtime: h.runtime });
    const tr = json(await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID } }));
    expect(tr.account.displayName).toBe('Thương hiệu 🚀');
    await h.dispatcher.drain();
    const found = json(await app.inject({ method: 'GET', url: `/api/v1/posts?q=${encodeURIComponent('hình nền động')}` }));
    expect(found.items).toHaveLength(1);
    expect(found.items[0].caption).toBe(text);
    expect(found.items[0].hashtags).toEqual(['hìnhnền']);
    const byTag = json(await app.inject({ method: 'GET', url: `/api/v1/posts?hashtag=${encodeURIComponent('#HìnhNền')}` }));
    expect(byTag.items).toHaveLength(1);
  });
});

describe('database constraints', () => {
  it('enforces one ACTIVE job per idempotency key at the DB level, but allows a new one after completion', async () => {
    h = await createHarness({});
    const mk = (status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED') => h.db.job.create({ data: { queue: 'collection', name: 'account.sync', idempotencyKey: 'k1', status } });
    await mk('QUEUED');
    await expect(mk('RUNNING')).rejects.toThrow();
    await h.db.job.updateMany({ where: { idempotencyKey: 'k1' }, data: { status: 'SUCCEEDED' } });
    await expect(mk('QUEUED')).resolves.toBeTruthy();
    await expect(mk('SUCCEEDED')).resolves.toBeTruthy();
  });

  it('enforces unique (platform, external_id) and cascades account deletion to posts and metrics', async () => {
    h = await createHarness({});
    const base = { platform: 'bluesky', externalId: 'did:plc:x', profileUrl: 'u', providerId: 'bluesky-appview', policyId: 'p', schemaVersion: 's' };
    const a = await h.db.socialAccount.create({ data: base });
    await expect(h.db.socialAccount.create({ data: base })).rejects.toThrow();
    const p = await h.db.post.create({ data: { platform: 'bluesky', externalId: 'at://x/1', accountId: a.id, url: 'u', contentType: 'text', sortAt: new Date(), lastCollectedAt: new Date(), providerId: 'bluesky-appview', policyId: 'p', schemaVersion: 's' } });
    await h.db.postMetric.create({ data: { postId: p.id, collectedAt: new Date(), likes: 1n, providerId: 'bluesky-appview', policyId: 'p' } });
    await h.db.socialAccount.delete({ where: { id: a.id } });
    expect(await h.db.post.count()).toBe(0);
    expect(await h.db.postMetric.count()).toBe(0);
  });

  it('seeds providers/policies from the Phase 0 capability records with deny-by-default policies', async () => {
    h = await createHarness({});
    expect(await h.db.provider.count()).toBe(10);
    const pol = await h.db.dataPolicy.findUniqueOrThrow({ where: { id: 'youtube-nonauthorized-v0' } });
    expect(pol).toMatchObject({ retentionDays: 30, refreshDays: 30, allowedOperations: { allowHistoricalSnapshots: false, allowDerivedMetrics: false, allowExport: false, allowMediaProcessing: false } });
  });
});

describe('quota guard (Phase 1 daily cap)', () => {
  it('refuses provider calls once the daily cap is used, with BUDGET_EXCEEDED (429) and no request sent', async () => {
    let calls = 0;
    h = await createHarness({ '/xrpc/app.bsky.actor.getProfile': () => (calls++, { body: fixtureProfile() }) }, { BLUESKY_DAILY_REQUESTS: '1' });
    app = await buildServer({ runtime: h.runtime });
    const first = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, sync: false } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, sync: false } });
    expect(second.statusCode).toBe(429);
    expect(json(second).error.code).toBe('BUDGET_EXCEEDED');
    expect(calls).toBe(1);
    const usage = json(await app.inject({ method: 'GET', url: '/api/v1/usage' }));
    expect(usage.providers.find((p: { providerId: string }) => p.providerId === 'bluesky-appview').usageToday).toMatchObject({ requests: 1, dailyCap: 1 });
  });
});

describe('scheduled executions', () => {
  it('a scheduler-triggered job creates its own DB job row and is skipped while an identical job is active', async () => {
    h = await createHarness({ '/xrpc/_health': () => ({ body: { version: 'fixture' } }) });
    const processor = createJobProcessor(h.runtime.ctx);
    const ac = new AbortController();
    await processor({ jobId: 'bullmq-repeat-1', name: 'scheduled:provider.health' as never, payload: { scheduleId: 'wf13-provider-health', providerId: 'bluesky-appview' }, attempt: 1, signal: ac.signal });
    const rows = await h.db.job.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'provider.health', status: 'SUCCEEDED', idempotencyKey: 'provider.health:-:bluesky-appview:-' });
    const prov = await h.db.provider.findUniqueOrThrow({ where: { id: 'bluesky-appview' } });
    expect(prov.lastHealth).toMatchObject({ healthy: true });

    // identical active job → scheduled run skipped (no second row)
    await new JobService(h.runtime.ctx).create({ name: 'provider.health', payload: { providerId: 'bluesky-appview' }, idempotencyKey: 'provider.health:-:bluesky-appview:-', dispatch: false });
    await processor({ jobId: 'bullmq-repeat-2', name: 'scheduled:provider.health' as never, payload: { scheduleId: 'wf13-provider-health', providerId: 'bluesky-appview' }, attempt: 1, signal: ac.signal });
    expect(await h.db.job.count()).toBe(2);
  });

  it('manual sync and track share the same dedup key', async () => {
    h = await createHarness({ '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }) });
    const acc = new AccountService(h.runtime.ctx);
    // Block the job from running by not draining; inline dispatcher runs async, so create directly without dispatch.
    const tracked = await acc.track({ input: FIXTURE_DID, sync: false });
    await new JobService(h.runtime.ctx).create({ name: 'account.sync', payload: { accountId: tracked.account.id, projectId: null, trigger: 'schedule' }, idempotencyKey: `account.sync:-:${tracked.account.id}:-`, dispatch: false });
    await expect(acc.enqueueSync(tracked.account.id, null, 'manual')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
