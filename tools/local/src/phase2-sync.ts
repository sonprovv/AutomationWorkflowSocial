#!/usr/bin/env node
/**
 * Phase 2 real-data sync evidence (Master Plan §16: "real-data sync, usage + provenance"):
 *   several real accounts → track → initial sync → incremental sync → metrics refresh → API read-back
 *
 *   npm run phase2:sync -- [account ...]      (default: 3 public Bluesky accounts)
 *
 * Ephemeral embedded PostgreSQL, inline dispatcher, the real API (in-process) and the real adapters.
 * The only manipulation is a TEST CONTROL: before the refresh step, `last_metrics_at` is moved back 2 h so
 * the just-synced posts are due (otherwise the age tiers would correctly skip them). No data is invented.
 * Writes a redacted report to docs/phase2/real-sync/<timestamp>.json. Bounded: about 5–8 requests per account.
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

const inputs = process.argv.slice(2).length ? process.argv.slice(2) : ['https://bsky.app/profile/bsky.app', 'https://bsky.app/profile/atproto.com', 'https://bsky.app/profile/nytimes.com'];
const root = findRepoRoot();
const dataDir = mkdtempSync(join(tmpdir(), 'sss-phase2-pg-'));
const started = new Date();
const steps: { step: string; ms: number; status?: number; summary?: unknown }[] = [];
const t = () => performance.now();

const pg = await startEmbeddedPostgres({ dataDir, password: 'phase2-ephemeral', persistent: false });
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
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, ms: Math.round(t() - s) };
  };
  const job = async (id: string) => (await call('GET', `/api/v1/jobs/${id}`)).body;

  const project = await call('POST', '/api/v1/projects', { name: 'Phase 2 real-data sync', platforms: ['bluesky', 'youtube'] });
  const accounts: { input: string; id: string | null; error?: unknown }[] = [];
  const initialJobs: string[] = [];
  for (const input of inputs) {
    const r = await call('POST', '/api/v1/accounts', { input, projectId: project.body.id });
    steps.push({ step: `track ${input}`, ms: r.ms, status: r.status, summary: r.body.account ? { platform: r.body.account.platform, externalId: r.body.account.externalId, username: r.body.account.username } : r.body.error });
    accounts.push({ input, id: r.body.account?.id ?? null, error: r.status >= 300 ? r.body.error : undefined });
    if (r.body.job_id) initialJobs.push(r.body.job_id);
  }
  let s = t();
  await dispatcher.drain();
  const initial = await Promise.all(initialJobs.map(job));
  steps.push({ step: 'initial syncs', ms: Math.round(t() - s), summary: initial.map((j) => ({ status: j.status, result: j.result && { mode: j.result.mode, pages: j.result.pages, postsNew: j.result.postsNew, usage: j.result.usage } })) });

  const tracked = accounts.filter((a) => a.id);
  const incJobs: string[] = [];
  for (const a of tracked) incJobs.push((await call('POST', `/api/v1/accounts/${a.id}/sync`, { projectId: project.body.id })).body.job_id);
  s = t();
  await dispatcher.drain();
  const incremental = await Promise.all(incJobs.map(job));
  steps.push({ step: 'incremental syncs', ms: Math.round(t() - s), summary: incremental.map((j) => ({ status: j.status, result: j.result && { mode: j.result.mode, pages: j.result.pages, postsNew: j.result.postsNew, postsUpdated: j.result.postsUpdated, usage: j.result.usage } })) });

  // TEST CONTROL (see header): make the just-synced posts due for the refresh tiers.
  await db.post.updateMany({ data: { lastMetricsAt: new Date(Date.now() - 2 * 3600_000) } });
  const rf = await call('POST', '/api/v1/metrics/refresh', { projectId: project.body.id });
  s = t();
  await dispatcher.drain();
  const refresh = await job(rf.body.job_id);
  steps.push({ step: 'metrics refresh (all tracked)', ms: Math.round(t() - s), status: rf.status, summary: { status: refresh.status, result: refresh.result } });

  const sample = await call('GET', `/api/v1/posts?projectId=${project.body.id}&limit=5`);
  steps.push({
    step: 'GET /posts (top 5)',
    ms: sample.ms,
    status: sample.status,
    summary: sample.body.items.map((p: Record<string, any>) => ({ url: p.url, publishedAt: p.publishedAt, providerIndexedAt: p.providerIndexedAt, metrics: p.metrics, provenance: p.provenance })),
  });
  const usage = await call('GET', '/api/v1/usage');
  const runs = await db.collectionRun.findMany({ orderBy: { startedAt: 'asc' }, select: { operation: true, status: true, requestCount: true, recordCount: true, quotaUnits: true, latencyMs: true, errorCode: true } });

  const counts = { accounts: await db.socialAccount.count(), posts: await db.post.count(), postMetrics: await db.postMetric.count(), unavailablePosts: await db.post.count({ where: { status: 'UNAVAILABLE' } }), withIndexedAt: await db.post.count({ where: { providerIndexedAt: { not: null } } }), jobs: await db.job.count() };
  const dup = await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM (SELECT platform, external_id FROM posts GROUP BY 1,2 HAVING COUNT(*) > 1) d`;
  const missingProvenance = await db.post.count({ where: { OR: [{ providerId: '' }, { policyId: '' }, { schemaVersion: '' }] } });

  const report = redactDeep({
    schema: 'sss.phase2-real-sync/v1',
    kind: 'REAL DATA — live provider calls',
    inputs,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, db: 'embedded PostgreSQL (ephemeral)', queue: 'inline (dev mode)' },
    testControls: ['last_metrics_at moved back 2 h before the refresh step; only posts in the <48 h tier (refresh every 1 h) become due, older tiers correctly stay not due'],
    seededProviders: seeded,
    accounts,
    steps,
    collectionRuns: runs,
    usage: usage.body,
    dbCounts: counts,
    checks: {
      allTracked: tracked.length === inputs.length,
      initialSyncsSucceeded: initial.every((j) => j.status === 'SUCCEEDED'),
      incrementalSyncsSucceeded: incremental.every((j) => j.status === 'SUCCEEDED' && j.result?.mode === 'incremental'),
      refreshSucceeded: refresh.status === 'SUCCEEDED' || refresh.status === 'PARTIAL_SUCCESS',
      refreshUpdatedAllDue: refresh.result && refresh.result.postsUpdated + refresh.result.postsUnavailable === refresh.result.postsDue,
      noDuplicatePosts: Number(dup[0]?.n ?? 0) === 0,
      provenanceOnEveryPost: missingProvenance === 0,
      oneSnapshotPerPostUnderPolicy: counts.postMetrics === counts.posts - counts.unavailablePosts || counts.postMetrics === counts.posts,
      usageRecorded: runs.length > 0 && runs.every((r) => r.requestCount > 0),
    },
  });
  const outDir = join(root, 'docs', 'phase2', 'real-sync');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${started.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  for (const st of steps) console.log(`${String(st.status ?? '').padEnd(4)} ${st.step} (${st.ms} ms)`);
  console.log('counts', counts);
  console.log('checks', report.checks);
  console.log('report:', file);
  await app.close();
  await db.$disconnect();
  if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
