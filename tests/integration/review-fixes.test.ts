/**
 * Regression tests for the Phase 1 code review (2026-11-26): job status under timeout / re-delivery /
 * orphaning, usage cost accounting, incremental sync stop logic. SYNTHETIC data via the fake AppView.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AccountService, createJobProcessor, JobService, UsageGuard } from '@sss/services';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('job status bookkeeping', () => {
  it('records a job timeout as FAILED/TIMEOUT, not as a user cancel', async () => {
    h = await createHarness({ '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }) });
    const tracked = await new AccountService(h.runtime.ctx).track({ input: FIXTURE_DID, sync: false });
    const jobs = new JobService(h.runtime.ctx);
    const job = await jobs.create({ name: 'account.sync', payload: { accountId: tracked.account.id, projectId: null, trigger: 'manual' }, idempotencyKey: 'k-timeout', dispatch: false });
    const signal = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    await expect(createJobProcessor(h.runtime.ctx)({ jobId: job.id, name: 'account.sync', payload: job.payload, attempt: 1, signal })).rejects.toThrow();
    expect(await h.db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', errorCode: 'TIMEOUT' });
  });

  it('resumes the same DB row when a scheduled execution is re-delivered after a stall', async () => {
    h = await createHarness({ '/xrpc/_health': () => ({ body: { version: 'fixture' } }) });
    const jobs = new JobService(h.runtime.ctx);
    // First delivery created the row and started it, then the worker died (row left RUNNING).
    const stuck = await jobs.create({ name: 'provider.health', payload: { providerId: 'bluesky-appview' }, idempotencyKey: 'provider.health:-:bluesky-appview:-', dispatch: false, maxAttempts: 1, correlationId: 'repeat:wf13:1' });
    await jobs.markRunning(stuck.id, 1);
    await createJobProcessor(h.runtime.ctx)({ jobId: 'repeat:wf13:1', name: 'scheduled:provider.health' as never, payload: { scheduleId: 'wf13-provider-health', providerId: 'bluesky-appview' }, attempt: 1, signal: new AbortController().signal });
    const rows = await h.db.job.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: stuck.id, status: 'SUCCEEDED' });
  });

  it('marks active jobs whose execution is gone as FAILED/ORPHANED and leaves finished jobs alone', async () => {
    h = await createHarness({});
    const jobs = new JobService(h.runtime.ctx);
    const active = await jobs.create({ name: 'provider.health', payload: { providerId: null }, idempotencyKey: 'k-orphan', dispatch: false });
    const done = await jobs.create({ name: 'provider.health', payload: { providerId: null }, idempotencyKey: 'k-done', dispatch: false });
    await jobs.finish(done.id, 'SUCCEEDED');
    const young = await jobs.create({ name: 'provider.health', payload: { providerId: null }, idempotencyKey: 'k-young', dispatch: false });
    await h.db.job.update({ where: { id: young.id }, data: { createdAt: new Date(Date.now() + 60_000) } });
    expect(await jobs.reconcileOrphans(async () => false, new Date(Date.now() + 1_000))).toEqual([active.id]);
    expect(await h.db.job.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ status: 'FAILED', errorCode: 'ORPHANED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: young.id } })).toMatchObject({ status: 'QUEUED' });
  });
});

describe('usage accounting', () => {
  it('books the cost of an operation once, not once per unit row', async () => {
    h = await createHarness({});
    const guard = new UsageGuard(h.runtime.ctx);
    await guard.record('bluesky-appview', { requests: 2, records: 3, quotaUnits: 4, costUsd: 0.5 } as never, {});
    const sum = await h.db.usageLog.aggregate({ where: { providerId: 'bluesky-appview' }, _sum: { actualCost: true } });
    expect(Number(sum._sum.actualCost)).toBeCloseTo(0.5);
    expect(await h.db.usageLog.count()).toBe(3);
  });
});

describe('incremental sync stop logic', () => {
  it('does not stop at a pinned old post on page 1; reads on until the oldest post passes the watermark', async () => {
    let phase: 'initial' | 'incremental' = 'initial';
    h = await createHarness({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
      '/xrpc/app.bsky.feed.getAuthorFeed': ({ url }) => {
        if (phase === 'initial') return { body: { feed: [fixturePost('3w1', '2026-11-20T00:00:00.000Z')] } };
        if (!url.searchParams.get('cursor')) {
          // pinned (old) post first, then a new one
          return { body: { feed: [fixturePost('3pin', '2026-01-01T00:00:00.000Z'), fixturePost('3n2', '2026-11-26T05:00:00.000Z')], cursor: 'c2' } };
        }
        return { body: { feed: [fixturePost('3n1', '2026-11-26T04:00:00.000Z'), fixturePost('3w1', '2026-11-20T00:00:00.000Z')] } };
      },
    });
    const acc = new AccountService(h.runtime.ctx);
    const tracked = await acc.track({ input: FIXTURE_DID, sync: true });
    await h.dispatcher.drain();
    phase = 'incremental';
    const q = await acc.enqueueSync(tracked.account.id, null, 'manual');
    await h.dispatcher.drain();
    const job = await h.db.job.findUniqueOrThrow({ where: { id: q.id } });
    expect(job.result).toMatchObject({ mode: 'incremental', pages: 2, postsNew: 3 });
    expect(await h.db.post.count()).toBe(4);
  });
});
