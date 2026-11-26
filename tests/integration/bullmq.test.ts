/**
 * BullMQ path (production queue): API → Redis → worker process logic → DB.
 * Runs only when a Redis-compatible server is reachable at TEST_REDIS_URL (default redis://127.0.0.1:6379),
 * e.g. Memurai on Windows or `brew services start redis` on macOS. Otherwise it is SKIPPED (reported, not passed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Worker } from 'bullmq';
import { BullMqDispatcher, redisConnection } from '@sss/queue';
import { createRuntime, type Runtime } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { startWorkers } from '../../apps/worker/src/worker.ts';
import { redisReachable } from '../../tools/local/src/checks.ts';
import { createHarness, fixturePost, fixtureProfile, testConfig, type Harness } from './helpers.ts';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const reachable = (await redisReachable(REDIS_URL)).ok;

describe.skipIf(!reachable)(`BullMQ end-to-end (Redis at ${REDIS_URL})`, () => {
  let h: Harness;
  let rt: Runtime;
  let workers: Worker[];

  beforeAll(async () => {
    h = await createHarness({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
      '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [fixturePost('3b1', '2026-11-25T01:00:00.000Z')] } }),
    });
    const redis = redisConnection(REDIS_URL);
    const config = testConfig({ QUEUE_DRIVER: 'bullmq', REDIS_URL });
    rt = createRuntime(config, { db: h.db, dispatcher: new BullMqDispatcher(redis) });
    workers = startWorkers(rt.ctx, redis, { concurrency: 1, jobTimeoutMs: 30_000 });
  });

  afterAll(async () => {
    await Promise.all((workers ?? []).map((w) => w.close()));
    for (const q of ['collection', 'maintenance']) await (rt?.ctx.dispatcher as BullMqDispatcher | undefined)?.queue(q as 'collection').obliterate({ force: true }).catch(() => {});
    await rt?.close();
    await h?.close();
  });

  it('track → job in Redis → worker → SUCCEEDED in DB', async () => {
    const app = await buildServer({ runtime: rt });
    const tr = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: 'https://bsky.app/profile/fixture.example.com' } })).body);
    expect(tr.job_id).toBeTruthy();
    let status = 'QUEUED';
    for (let i = 0; i < 60 && ['QUEUED', 'RUNNING'].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await h.db.job.findUniqueOrThrow({ where: { id: tr.job_id } })).status;
    }
    expect(status).toBe('SUCCEEDED');
    expect(await h.db.post.count()).toBe(1);
    const ready = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/health/ready' })).body);
    expect(ready).toMatchObject({ status: 'ready', queueDriver: 'bullmq' });
  });
});
