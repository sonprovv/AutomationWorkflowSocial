#!/usr/bin/env node
/**
 * Phase 6 evidence with REAL data: real Bluesky discovery → approve → sync → viral / trends / AI.
 *
 *   npm run phase6:analytics
 *
 * Step A (default policy): derived analytics must be BLOCKED and no post text may be sent to the AI provider.
 * Step B (TEST CONTROL, throwaway database only): allowDerivedMetrics=true for Bluesky to prove viral-v1 and
 * trends-v1 on real data. AI runs only if ANTHROPIC_API_KEY is set; otherwise AUTH_REQUIRED is the expected result.
 * Screenshot of the Insights page and full results stay in .data/evidence/ (git-ignored, third-party content);
 * the committed report holds structure and counts only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactDeep } from '@sss/collector-core';
import { configSchema, findRepoRoot } from '@sss/config';
import { createDb, freePort, migrateDeploy, startEmbeddedPostgres } from '@sss/database';
import { InlineDispatcher } from '@sss/queue';
import { createRuntime, seedFromCapabilityRecords } from '@sss/services';
import { buildServer } from '../../../apps/api/src/server.ts';

const root = findRepoRoot();
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-');
const evidenceDir = join(root, '.data', 'evidence', 'phase6', stamp);
mkdirSync(evidenceDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'sss-phase6-pg-'));
const steps: { step: string; ok: boolean; summary?: unknown }[] = [];

const pg = await startEmbeddedPostgres({ dataDir, password: 'phase6-ephemeral', persistent: false });
try {
  await migrateDeploy(pg.url);
  const config = configSchema.parse({ ...process.env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent' });
  const db = createDb(pg.url);
  await seedFromCapabilityRecords(db);
  const dispatcher = new InlineDispatcher();
  const app = await buildServer({ runtime: createRuntime(config, { db, dispatcher }), webDist: join(root, 'apps', 'web', 'dist') });
  const port = await freePort();
  await app.listen({ host: '127.0.0.1', port });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await fetch(`${base}/api/v1${url}`, { method, headers: payload !== undefined ? { 'content-type': 'application/json' } : {}, body: payload !== undefined ? JSON.stringify(payload) : undefined });
    return { status: r.status, body: (r.status === 204 ? null : await r.json()) as any };
  };
  const runJob = async (url: string, payload: object = {}) => {
    const r = await call('POST', url, payload);
    await dispatcher.drain();
    return (await call('GET', `/jobs/${r.body.job_id}`)).body;
  };

  const project = (await call('POST', '/projects', { name: 'Phase 6 analytics (real data)', platforms: ['bluesky'], languages: ['en'] })).body;
  await call('POST', `/projects/${project.id}/keywords`, { keywords: [{ text: 'live wallpaper' }, { text: 'wallpaper' }] });
  const d = await runJob(`/projects/${project.id}/discover`);
  const queue = (await call('GET', `/projects/${project.id}/candidates?status=PENDING&limit=5`)).body.items as { id: string }[];
  await call('POST', `/projects/${project.id}/candidates/approve`, { candidateIds: queue.map((c) => c.id) });
  // Discovery candidates are often small accounts with few recent posts; add two active public accounts so the
  // analytics have a meaningful real sample.
  for (const input of ['https://bsky.app/profile/nytimes.com', 'https://bsky.app/profile/bsky.app']) await call('POST', '/accounts', { input, projectId: project.id });
  await dispatcher.drain();
  const posts = await db.post.count();
  steps.push({ step: 'real data: discover → approve top 5 + track 2 active accounts → sync', ok: posts > 0, summary: { discovery: d.status, approved: queue.length, posts } });

  // A) default policy.
  const v0 = await runJob(`/projects/${project.id}/analytics/viral`);
  const t0 = await runJob(`/projects/${project.id}/analytics/trends`, { windowDays: 30 });
  const a0 = await runJob(`/projects/${project.id}/analyze`);
  steps.push({
    step: 'default policy: viral, trends and AI blocked (nothing scored, nothing sent to the AI provider)',
    ok: v0.result.scored === 0 && v0.result.blockedByPolicy.length > 0 && t0.result.coverage.blockedByPolicy.length > 0 && a0.result.analyzed === 0 && a0.result.blockedByPolicy.length > 0,
    summary: { viral: { status: v0.status, blocked: v0.result.blockedByPolicy }, trends: { blocked: t0.result.coverage.blockedByPolicy }, ai: { status: a0.status, blocked: a0.result.blockedByPolicy } },
  });

  // B) TEST CONTROL.
  await db.dataPolicy.updateMany({ where: { providerId: 'bluesky-appview' }, data: { allowedOperations: { allowHistoricalSnapshots: false, allowDerivedMetrics: true, allowMediaProcessing: false, allowExport: false } } });
  const v1 = await runJob(`/projects/${project.id}/analytics/viral`);
  const viral = (await call('GET', `/analytics/viral?projectId=${project.id}&limit=200`)).body;
  const t1 = await runJob(`/projects/${project.id}/analytics/trends`, { windowDays: 30 });
  const trends = (await call('GET', `/analytics/trends?projectId=${project.id}`)).body;
  steps.push({
    step: 'viral-v1 on real posts (test control: derived metrics allowed)',
    ok: v1.status === 'SUCCEEDED' && v1.result.scored + v1.result.insufficientData === v1.result.postsConsidered,
    summary: {
      result: v1.result,
      scoreDistribution: viral.items.filter((i: any) => i.score !== null).map((i: any) => i.score).sort((a: number, b: number) => b - a).slice(0, 10),
      labels: viral.items.reduce((acc: Record<string, number>, i: any) => ((acc[i.label ?? i.status] = (acc[i.label ?? i.status] ?? 0) + 1), acc), {}),
      featuresAvailable: [...new Set(viral.items.flatMap((i: any) => i.features.available))],
    },
  });
  steps.push({
    step: 'trends-v1 on real posts (30-day windows)',
    ok: t1.status === 'SUCCEEDED',
    summary: { sampleSize: trends.sampleSize, topics: trends.topics.length, bySignal: trends.topics.reduce((acc: Record<string, number>, x: any) => ((acc[x.signal] = (acc[x.signal] ?? 0) + 1), acc), {}), confidence: [...new Set(trends.topics.map((x: any) => x.confidence))] },
  });
  const a1 = await runJob(`/projects/${project.id}/analyze`);
  const aiExpected = config.ANTHROPIC_API_KEY ? a1.status === 'SUCCEEDED' || a1.status === 'PARTIAL_SUCCESS' : a1.status === 'FAILED' && a1.error?.code === 'AUTH_REQUIRED';
  steps.push({ step: config.ANTHROPIC_API_KEY ? 'AI analysis with the configured key' : 'AI analysis without a key → AUTH_REQUIRED (expected until the key is provided)', ok: aiExpected, summary: { status: a1.status, error: a1.error, result: a1.result && { analyzed: a1.result.analyzed, refused: a1.result.refused, failed: a1.result.failed, inputTokens: a1.result.inputTokens, outputTokens: a1.result.outputTokens, costUsd: a1.result.costUsd } } });

  writeFileSync(join(evidenceDir, 'viral.json'), JSON.stringify(viral, null, 2));
  writeFileSync(join(evidenceDir, 'trends.json'), JSON.stringify(trends, null, 2));

  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
  if (exe) {
    const file = join(evidenceDir, 'ui-insights.png');
    await new Promise<void>((ok) => {
      const c = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(dataDir, 'browser')}`, '--window-size=1440,1600', '--virtual-time-budget=8000', `--screenshot=${file}`, `${base}/#/insights?projectId=${project.id}`], { stdio: 'ignore' });
      const t = setTimeout(() => c.kill(), 60_000);
      c.on('exit', () => (clearTimeout(t), ok()));
    });
    steps.push({ step: 'Insights page rendered', ok: existsSync(file) && statSync(file).size > 10_000, summary: { bytes: existsSync(file) ? statSync(file).size : 0 } });
  }

  const report = redactDeep({
    schema: 'sss.phase6-analytics/v1',
    kind: 'REAL DATA — live Bluesky calls; analytics computed on collected posts',
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    testControls: ['The script approves the 5 best-scored candidates.', 'allowDerivedMetrics=true for Bluesky in the throwaway database only (step B). The product stays deny-by-default until the Product Owner approves the policy.'],
    privateArtifacts: '.data/evidence/phase6/ (git-ignored): full viral/trends JSON and the Insights screenshot.',
    steps,
    checks: Object.fromEntries(steps.map((s) => [s.step, s.ok])),
  });
  mkdirSync(join(root, 'docs', 'phase6'), { recursive: true });
  const out = join(root, 'docs', 'phase6', `${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}`);
  console.log('report:', out, '\nprivate evidence:', evidenceDir);
  await app.close();
  await db.$disconnect();
  if (!steps.every((s) => s.ok)) process.exitCode = 1;
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
