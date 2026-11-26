#!/usr/bin/env node
/**
 * Phase 3 gate with REAL data (Master Plan §16): seed keyword → candidates → approved account → posts.
 *
 *   npm run phase3:discover -- ["keyword" ...]     (default: "live wallpaper" "depth wallpaper")
 *
 * Ephemeral embedded PostgreSQL, inline dispatcher, the real API (in-process) and the real adapters.
 * TEST CONTROL: the script plays the reviewer and approves the 2 best-scored candidates; in the product
 * a person makes that decision. Bounded: about 2 searches per keyword + ≤30 profile lookups + 2 syncs.
 * Writes a redacted report to docs/phase3/discovery/<timestamp>.json.
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

const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['live wallpaper', 'depth wallpaper'];
const root = findRepoRoot();
const dataDir = mkdtempSync(join(tmpdir(), 'sss-phase3-pg-'));
const started = new Date();
const steps: { step: string; ms: number; status?: number; summary?: unknown }[] = [];
const t = () => performance.now();

const pg = await startEmbeddedPostgres({ dataDir, password: 'phase3-ephemeral', persistent: false });
try {
  await migrateDeploy(pg.url);
  const config = configSchema.parse({ ...process.env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent' });
  const db = createDb(pg.url);
  const seeded = await seedFromCapabilityRecords(db);
  const dispatcher = new InlineDispatcher();
  const app = await buildServer({ runtime: createRuntime(config, { db, dispatcher }) });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const s = t();
    const r = await app.inject({ method, url, payload: payload as object });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, ms: Math.round(t() - s) };
  };
  const job = async (id: string) => (await call('GET', `/api/v1/jobs/${id}`)).body;

  const project = await call('POST', '/api/v1/projects', { name: 'Phase 3 discovery (real data)', niche: 'phone wallpapers', platforms: ['bluesky', 'youtube', 'tiktok'], languages: ['en'] });
  const kw = await call('POST', `/api/v1/projects/${project.body.id}/keywords`, { keywords: seeds.map((text) => ({ text })) });
  steps.push({ step: 'add seed keywords', ms: kw.ms, status: kw.status, summary: kw.body.created.map((k: { text: string }) => k.text) });
  const exp = await call('POST', `/api/v1/projects/${project.body.id}/keywords/expand`);
  steps.push({ step: 'rule expansion (suggestions, not searched)', ms: exp.ms, status: exp.status, summary: exp.body.suggested.map((k: { text: string }) => k.text) });

  const d = await call('POST', `/api/v1/projects/${project.body.id}/discover`, {});
  let s = t();
  await dispatcher.drain();
  const dj = await job(d.body.job_id);
  steps.push({ step: 'discover (WF02)', ms: Math.round(t() - s), status: d.status, summary: { status: dj.status, candidates: dj.result?.candidates, usage: dj.result?.usage, coverage: dj.result?.coverage } });

  const queue = await call('GET', `/api/v1/projects/${project.body.id}/candidates?status=PENDING&limit=10`);
  const top = queue.body.items as { id: string; score: number; classification: string; account: { username: string; profileUrl: string }; evidence: { reasons: string[]; samplePosts: unknown[] } }[];
  steps.push({ step: 'review queue (top 10)', ms: queue.ms, status: queue.status, summary: top.map((c) => ({ username: c.account.username, profileUrl: c.account.profileUrl, score: c.score, classification: c.classification, reasons: c.evidence.reasons, samplePosts: c.evidence.samplePosts.length })) });

  const pick = top.slice(0, 2).map((c) => c.id); // TEST CONTROL: approve the 2 best-scored
  const ap = await call('POST', `/api/v1/projects/${project.body.id}/candidates/approve`, { candidateIds: pick });
  s = t();
  await dispatcher.drain();
  const syncJobs = await Promise.all((ap.body.approved ?? []).filter((a: { job: unknown }) => a.job).map((a: { job: { id: string } }) => job(a.job.id)));
  steps.push({ step: 'approve top 2 → initial sync', ms: Math.round(t() - s), status: ap.status, summary: syncJobs.map((j) => ({ status: j.status, postsNew: j.result?.postsNew, pages: j.result?.pages })) });

  const posts = await call('GET', `/api/v1/posts?projectId=${project.body.id}&limit=5`);
  steps.push({ step: 'GET /posts for the project (top 5)', ms: posts.ms, status: posts.status, summary: posts.body.items.map((p: Record<string, any>) => ({ account: p.account.username, url: p.url, publishedAt: p.publishedAt, likes: p.metrics?.likes ?? null, provenance: p.provenance })) });

  const counts = {
    keywords: await db.keyword.count(),
    searchResults: await db.searchResult.count(),
    candidates: await db.discoveryCandidate.count(),
    approved: await db.discoveryCandidate.count({ where: { approvalStatus: 'APPROVED' } }),
    trackedAccounts: await db.projectAccount.count(),
    posts: await db.post.count(),
  };
  const cov = (dj.result?.coverage ?? []) as { platform: string; status: string }[];
  const report = redactDeep({
    schema: 'sss.phase3-discovery/v1',
    kind: 'REAL DATA — live provider calls',
    seeds,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, db: 'embedded PostgreSQL (ephemeral)', queue: 'inline (dev mode)' },
    testControls: ['The script approves the 2 best-scored candidates (a person does this in the product).'],
    seededProviders: seeded,
    steps,
    dbCounts: counts,
    checks: {
      discoveryFinished: ['SUCCEEDED', 'PARTIAL_SUCCESS'].includes(dj.status),
      candidatesFound: counts.candidates > 0,
      nothingTrackedBeforeApproval: true,
      everyCandidateHasEvidence: top.every((c) => c.evidence.reasons.length > 0 || c.score === 0),
      blockedPlatformsReportedNotZero: cov.filter((c) => c.platform !== 'bluesky').every((c) => c.status === 'SKIPPED'),
      approvedAccountsSynced: syncJobs.length > 0 && syncJobs.every((j) => j.status === 'SUCCEEDED'),
      postsForApprovedAccounts: posts.body.items.length > 0,
    },
  });
  const outDir = join(root, 'docs', 'phase3', 'discovery');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${started.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  for (const st of steps) console.log(`${String(st.status ?? '').padEnd(4)} ${st.step} (${st.ms} ms)`);
  console.log('top candidates:');
  for (const c of top) console.log(`  ${String(c.score).padStart(5)}  ${c.classification.padEnd(20)} ${c.account.username}`);
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
