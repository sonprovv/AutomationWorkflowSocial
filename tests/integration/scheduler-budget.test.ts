/**
 * Phase 4 — scheduler (claim, catch-up, pause, workflows API), atomic budget reservations, WF14 cleanup,
 * job monitor. REAL services + Postgres + inline dispatcher; fake AppView (SYNTHETIC data).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CollectorError } from '@sss/collector-core';
import { CleanupService, SchedulerService, UsageGuard } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

const ROUTES = {
  '/xrpc/_health': () => ({ body: { version: 'fixture' } }),
  '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
  '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [fixturePost('3s1', new Date(Date.now() - 3600_000).toISOString())] } }),
  '/xrpc/app.bsky.feed.getPosts': () => ({ body: { posts: [] } }),
};

describe('budget guard: atomic reservations (authorize → reserve → execute → reconcile)', () => {
  it('concurrent reservations never exceed the daily cap; settlement and expiry release capacity', async () => {
    h = await createHarness(ROUTES, { BLUESKY_DAILY_REQUESTS: '10' });
    const guard = new UsageGuard(h.runtime.ctx);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => guard.meterFor('bluesky-appview', 4)));
    const granted = await h.db.usageReservation.aggregate({ _sum: { amount: true } });
    expect(granted._sum.amount).toBe(10); // 4 + 4 + 2, never more
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CollectorError);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('BUDGET_EXCEEDED');

    // Reconcile one meter that used only 1 request: its reservation is settled, 3 units come back.
    const meter = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    await guard.record('bluesky-appview', { requests: 1, records: 0, quotaUnits: 0, costUsd: 0 } as never, {}, meter);
    expect(await guard.usedToday('bluesky-appview', 'requests')).toBe(1);
    const again = await guard.meterFor('bluesky-appview', 10);
    expect(again).toBeTruthy();
    const active = await h.db.usageReservation.findMany({ where: { settledAt: null }, orderBy: { createdAt: 'desc' } });
    expect(active[0]!.amount).toBe(3); // 10 cap − 1 used − 6 still reserved

    // A crashed worker's reservations expire and stop counting.
    await h.db.usageReservation.updateMany({ where: { settledAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await guard.meterFor('bluesky-appview', 100);
    const newest = await h.db.usageReservation.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(newest.amount).toBe(9);
  });

  it('a whole sync job settles its reservation with the real request count', async () => {
    h = await createHarness(ROUTES);
    app = await buildServer({ runtime: h.runtime });
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID } });
    await h.dispatcher.drain();
    const rows = await h.db.usageReservation.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBe(2); // track (resolve) + sync
    expect(rows.every((r) => r.settledAt !== null)).toBe(true);
    expect(rows[1]).toMatchObject({ amount: 60, used: 2 });
  });
});

describe('scheduler (DB-driven tick)', () => {
  async function trackedProject() {
    h = await createHarness(ROUTES);
    app = await buildServer({ runtime: h.runtime });
    const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Sched', platforms: ['bluesky'], settings: { sync_interval_minutes: 120 } } }));
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id, sync: false } });
    return pr.id as string;
  }

  it('creates the built-in schedules, fires due ones once, and catches up a long downtime with a single run', async () => {
    await trackedProject();
    let clock = new Date();
    h.runtime.ctx.now = () => clock;
    const s = new SchedulerService(h.runtime.ctx);

    const t1 = await s.tick();
    expect(t1.fired.map((f) => `${f.scheduleId}:${f.outcome.status}`).sort()).toEqual([
      'wf02-discovery:NOTHING_DUE',
      'wf04-account-sync:ENQUEUED',
      'wf05-metrics-refresh:ENQUEUED',
      'wf07-viral:ENQUEUED',
      'wf09-trends:ENQUEUED',
      'wf13-provider-health:ENQUEUED',
    ]); // WF08 (07:00) and WF14 (03:00) are cron schedules and wait for their slot
    await h.dispatcher.drain();
    expect(await h.db.job.count({ where: { name: 'account.sync', status: 'SUCCEEDED' } })).toBe(1);
    const link = await h.db.projectAccount.findFirstOrThrow();
    expect(link.nextSyncAt!.getTime()).toBe(clock.getTime() + 120 * 60_000);

    // Nothing is due one second later.
    clock = new Date(clock.getTime() + 1000);
    expect((await s.tick()).fired).toEqual([]);

    // Downtime of 3 days: every schedule fires ONCE (no replay of missed slots), next run is computed from now.
    clock = new Date(clock.getTime() + 3 * 86400_000);
    const t3 = await s.tick();
    expect(t3.fired.filter((f) => f.scheduleId === 'wf05-metrics-refresh')).toHaveLength(1);
    expect(t3.fired.map((f) => f.scheduleId)).toContain('wf14-policy-cleanup');
    const wf05 = await h.db.schedule.findUniqueOrThrow({ where: { id: 'wf05-metrics-refresh' } });
    expect(wf05.nextRunAt!.getTime()).toBe(clock.getTime() + 3600_000);
    await h.dispatcher.drain();
  });

  it('two concurrent tick runners never fire the same slot twice', async () => {
    await trackedProject();
    const a = new SchedulerService(h.runtime.ctx);
    const b = new SchedulerService(h.runtime.ctx);
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const fired = [...ra.fired, ...rb.fired].map((f) => f.scheduleId);
    expect(new Set(fired).size).toBe(fired.length);
    expect(fired).toContain('wf04-account-sync');
    await h.dispatcher.drain();
    expect(await h.db.job.count({ where: { name: 'account.sync' } })).toBe(1);
  });

  it('pause stops firing; workflows API edits, validates and runs schedules', async () => {
    await trackedProject();
    const pause = await app!.inject({ method: 'POST', url: '/api/v1/scheduler/pause' });
    expect(json(pause)).toEqual({ paused: true });
    expect(await new SchedulerService(h.runtime.ctx).tick()).toMatchObject({ paused: true, fired: [] });
    await app!.inject({ method: 'POST', url: '/api/v1/scheduler/resume' });

    const list = json(await app!.inject({ method: 'GET', url: '/api/v1/workflows' }));
    expect(list.paused).toBe(false);
    expect(list.items.map((w: { id: string }) => w.id)).toEqual(['wf02-discovery', 'wf04-account-sync', 'wf05-metrics-refresh', 'wf07-viral', 'wf08-ai-analysis', 'wf09-trends', 'wf11-daily-report', 'wf12-weekly-report', 'wf13-provider-health', 'wf14-policy-cleanup']);
    const bad = await app!.inject({ method: 'PATCH', url: '/api/v1/workflows/wf14-policy-cleanup', payload: { cron: 'not a cron' } });
    expect(bad.statusCode).toBe(400);
    const ok = json(await app!.inject({ method: 'PATCH', url: '/api/v1/workflows/wf05-metrics-refresh', payload: { everyMinutes: 30 } }));
    expect(ok).toMatchObject({ everyMinutes: 30, cron: null });
    const off = json(await app!.inject({ method: 'PATCH', url: '/api/v1/workflows/wf04-account-sync', payload: { enabled: false } }));
    expect(off.enabled).toBe(false);
    const run = json(await app!.inject({ method: 'POST', url: '/api/v1/workflows/wf14-policy-cleanup/run' }));
    expect(run).toMatchObject({ status: 'ENQUEUED', jobIds: [expect.any(String)] });
    await h.dispatcher.drain();
    expect((await h.db.job.findUniqueOrThrow({ where: { id: run.jobIds[0] } })).status).toBe('SUCCEEDED');
    const created = await app!.inject({ method: 'POST', url: '/api/v1/workflows', payload: { id: 'health-bluesky', workflowKey: 'WF13_PROVIDER_HEALTH_CHECK', everyMinutes: 10, config: { providerId: 'bluesky-appview' } } });
    expect(created.statusCode).toBe(201);
  });
});

describe('WF14 policy cleanup and the job monitor', () => {
  it('deletes provider-deleted posts after the grace period, keeps data when retention is unverified', async () => {
    h = await createHarness(ROUTES);
    app = await buildServer({ runtime: h.runtime });
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID } });
    await h.dispatcher.drain();
    const post = await h.db.post.findFirstOrThrow();
    await h.db.post.update({ where: { id: post.id }, data: { status: 'UNAVAILABLE', unavailableAt: new Date(Date.now() - 4 * 86400_000), unavailableReason: 'NOT_RETURNED_BY_PROVIDER' } });
    const r = await new CleanupService(h.runtime.ctx).run();
    expect(r.unavailablePostsDeleted).toBe(1);
    expect(await h.db.post.count()).toBe(0);
    expect(await h.db.postMetric.count()).toBe(0);
    expect(r.retention.find((x) => x.providerId === 'bluesky-appview')).toMatchObject({ retentionDays: null, postsDeleted: 0 });
    expect(await h.db.auditLog.count({ where: { action: 'cleanup.run' } })).toBe(1);
  });

  it('job monitor reports counts, active jobs and a dead-letter view of failures', async () => {
    h = await createHarness({ '/xrpc/app.bsky.actor.getProfile': () => ({ status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } }) });
    app = await buildServer({ runtime: h.runtime });
    const acc = await h.db.socialAccount.create({ data: { platform: 'bluesky', externalId: FIXTURE_DID, profileUrl: 'https://bsky.app/profile/x', providerId: 'bluesky-appview', policyId: 'bluesky-public-v0-unverified', schemaVersion: 't' } });
    await app.inject({ method: 'POST', url: `/api/v1/accounts/${acc.id}/sync`, payload: {} });
    await h.dispatcher.drain();
    const st = json(await app.inject({ method: 'GET', url: '/api/v1/jobs/stats' }));
    expect(st.byStatus).toMatchObject({ FAILED: 1 });
    expect(st.byName['account.sync']).toMatchObject({ FAILED: 1 });
    expect(st.deadLetter.byErrorCode).toEqual({ NOT_FOUND: 1 });
    expect(st.deadLetter.recent[0]).toMatchObject({ name: 'account.sync', retryUrl: expect.stringMatching(/\/retry$/) });
    expect(st.active).toEqual([]);
  });
});
