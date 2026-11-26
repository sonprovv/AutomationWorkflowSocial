#!/usr/bin/env node
/**
 * P1-06 vertical slice with REAL data (Master Plan §16.1):
 *   account URL → real provider → PostgreSQL → REST API read-back
 *
 *   npm run slice -- https://bsky.app/profile/bsky.app
 *
 * Uses an ephemeral embedded PostgreSQL and the inline dispatcher (no Redis needed), the real API server
 * (in-process HTTP via inject) and the real Bluesky adapter. Writes a redacted evidence report to
 * docs/phase1/vertical-slice/<timestamp>.json. Bounded: one track + two syncs (~10 provider requests).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactDeep } from '@sss/collector-core';
import { configSchema, findRepoRoot } from '@sss/config';
import { createDb, migrateDeploy, startEmbeddedPostgres } from '@sss/database';
import { InlineDispatcher } from '@sss/queue';
import { createRuntime, seedFromCapabilityRecords } from '@sss/services';
import { buildServer } from '../../../apps/api/src/server.ts';

const input = process.argv[2] ?? 'https://bsky.app/profile/bsky.app';
const root = findRepoRoot();
const dataDir = mkdtempSync(join(tmpdir(), 'sss-slice-pg-'));
const started = new Date();
const steps: { step: string; ms: number; status?: number; summary?: unknown }[] = [];
const t = () => performance.now();

const pg = await startEmbeddedPostgres({ dataDir, password: 'slice-ephemeral', persistent: false });
try {
  await migrateDeploy(pg.url);
  const config = configSchema.parse({ ...process.env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent' });
  const db = createDb(pg.url);
  const seeded = await seedFromCapabilityRecords(db);
  const dispatcher = new InlineDispatcher();
  const runtime = createRuntime(config, { db, dispatcher });
  const app = await buildServer({ runtime });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const s = t();
    const r = await app.inject({ method, url, payload: payload as object });
    const body = r.body ? JSON.parse(r.body) : null;
    return { status: r.statusCode, body, ms: Math.round(t() - s) };
  };

  const project = await call('POST', '/api/v1/projects', { name: 'Vertical slice (real data)', platforms: ['bluesky'] });
  steps.push({ step: 'create project', ms: project.ms, status: project.status });

  const track = await call('POST', '/api/v1/accounts', { input, projectId: project.body.id });
  steps.push({ step: `track ${input}`, ms: track.ms, status: track.status, summary: track.body.account ?? track.body.error });
  if (track.status >= 300) throw new Error(`track failed: ${JSON.stringify(track.body)}`);

  let s = t();
  await dispatcher.drain();
  const job1 = await call('GET', `/api/v1/jobs/${track.body.job_id}`);
  steps.push({ step: 'initial sync job', ms: Math.round(t() - s), status: job1.status, summary: { status: job1.body.status, result: job1.body.result } });

  const posts = await call('GET', `/api/v1/posts?accountId=${track.body.account.id}&limit=5`);
  steps.push({
    step: 'GET /posts (top 5)',
    ms: posts.ms,
    status: posts.status,
    summary: posts.body.items.map((p: { url: string; publishedAt: string; contentType: string; metrics: unknown }) => ({ url: p.url, publishedAt: p.publishedAt, contentType: p.contentType, metrics: p.metrics })),
  });

  const sync = await call('POST', `/api/v1/accounts/${track.body.account.id}/sync`, { projectId: project.body.id });
  s = t();
  await dispatcher.drain();
  const job2 = await call('GET', `/api/v1/jobs/${sync.body.job_id}`);
  steps.push({ step: 'incremental re-sync', ms: Math.round(t() - s), status: job2.status, summary: { status: job2.body.status, result: job2.body.result } });

  const counts = { posts: await db.post.count(), postMetrics: await db.postMetric.count(), accounts: await db.socialAccount.count(), accountMetrics: await db.accountMetric.count(), jobs: await db.job.count() };
  const dupCheck = await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM (SELECT platform, external_id FROM posts GROUP BY 1,2 HAVING COUNT(*) > 1) d`;
  const account = await call('GET', `/api/v1/accounts/${track.body.account.id}`);

  const report = redactDeep({
    schema: 'sss.vertical-slice/v1',
    kind: 'REAL DATA — Bluesky public AppView',
    input,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, db: 'embedded PostgreSQL 17 (ephemeral)', queue: 'inline (dev mode)' },
    seededProviders: seeded,
    steps,
    dbCounts: counts,
    duplicatePosts: Number(dupCheck[0]?.n ?? 0),
    account: { metrics: account.body.metrics, sync: account.body.sync, recentRuns: account.body.recentRuns },
    checks: {
      initialSyncSucceeded: job1.body.status === 'SUCCEEDED',
      resyncSucceeded: job2.body.status === 'SUCCEEDED',
      noDuplicatePosts: Number(dupCheck[0]?.n ?? 0) === 0,
      oneMetricSnapshotPerPost: counts.postMetrics === counts.posts,
      viewsNullNotZero: posts.body.items.every((p: { metrics: { views: unknown } | null }) => p.metrics?.views === null),
    },
  });
  const outDir = join(root, 'docs', 'phase1', 'vertical-slice');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${started.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  for (const st of steps) console.log(`${String(st.status ?? '').padEnd(4)} ${st.step} (${st.ms} ms)`);
  console.log('counts', counts, 'checks', report.checks);
  console.log('report:', file);
  await app.close();
  await db.$disconnect();
  if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
