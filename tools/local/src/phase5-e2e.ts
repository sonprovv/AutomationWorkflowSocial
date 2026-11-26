#!/usr/bin/env node
/**
 * Phase 5 gate with REAL data (Master Plan §16: "End-to-end UI + Excel file thật"):
 *   real Bluesky discovery → approve → sync → metrics → web UI pages (headless Edge/Chrome screenshots)
 *   → Excel/CSV/JSON exports validated by an independent reader (openpyxl).
 *
 *   npm run phase5:e2e
 *
 * Ephemeral embedded PostgreSQL, inline dispatcher, the real API + built web UI on a free local port.
 * TEST CONTROLS (documented in the report):
 *   1. the script approves the 2 best-scored candidates (a person does this in the product);
 *   2. after the default-policy export (rows WITHHELD, as the policy requires), the Bluesky policy is set to
 *      allowExport=true IN THE THROWAWAY DATABASE ONLY to prove the workbook with real rows. That workbook and
 *      the screenshots contain third-party content, so they are written to .data/evidence/ (git-ignored) and only
 *      their structure (counts, headers) goes into the committed report.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const evidenceDir = join(root, '.data', 'evidence', 'phase5', stamp);
mkdirSync(evidenceDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'sss-phase5-pg-'));
const steps: { step: string; ok: boolean; summary?: unknown }[] = [];
const webDist = join(root, 'apps', 'web', 'dist');
if (!existsSync(join(webDist, 'index.html'))) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

function browser(): string | null {
  const c = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return c.find((p) => existsSync(p)) ?? null;
}

const pg = await startEmbeddedPostgres({ dataDir, password: 'phase5-ephemeral', persistent: false });
try {
  await migrateDeploy(pg.url);
  const config = configSchema.parse({ ...process.env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent', EXPORT_DIR: join(evidenceDir, 'exports') });
  const db = createDb(pg.url);
  await seedFromCapabilityRecords(db);
  const dispatcher = new InlineDispatcher();
  const app = await buildServer({ runtime: createRuntime(config, { db, dispatcher }), webDist });
  const port = await freePort();
  await app.listen({ host: '127.0.0.1', port });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const r = await fetch(`${base}/api/v1${url}`, { method, headers: payload !== undefined ? { 'content-type': 'application/json' } : {}, body: payload !== undefined ? JSON.stringify(payload) : undefined });
    return { status: r.status, body: (r.status === 204 ? null : await r.json()) as any };
  };
  const job = async (id: string) => (await call('GET', `/jobs/${id}`)).body;

  // 1) Real data through the same API the UI uses.
  const project = (await call('POST', '/projects', { name: 'Phase 5 E2E (real data)', platforms: ['bluesky', 'youtube', 'tiktok'], languages: ['en'] })).body as { id: string };
  await call('POST', `/projects/${project.id}/keywords`, { keywords: [{ text: 'live wallpaper' }] });
  const d = await call('POST', `/projects/${project.id}/discover`, {});
  await dispatcher.drain();
  const dj = await job(d.body.job_id);
  steps.push({ step: 'discover (real Bluesky)', ok: ['SUCCEEDED', 'PARTIAL_SUCCESS'].includes(dj.status), summary: { status: dj.status, candidates: dj.result?.candidates } });
  const queue = (await call('GET', `/projects/${project.id}/candidates?status=PENDING&limit=2`)).body.items as { id: string }[];
  const ap = await call('POST', `/projects/${project.id}/candidates/approve`, { candidateIds: queue.map((c) => c.id) }); // TEST CONTROL 1
  await dispatcher.drain();
  steps.push({ step: 'approve top 2 → sync', ok: ap.status === 200, summary: { approved: ap.body.approved?.length } });
  await db.post.updateMany({ data: { lastMetricsAt: new Date(Date.now() - 2 * 3600_000) } });
  await call('POST', '/metrics/refresh', { projectId: project.id });
  await dispatcher.drain();
  const posts = (await call('GET', `/posts?projectId=${project.id}&limit=100`)).body.items.length;
  steps.push({ step: 'posts via API', ok: posts > 0, summary: { posts } });

  // 2) Exports.
  const exportAndValidate = async (format: 'xlsx' | 'csv' | 'json', label: string) => {
    const r = await call('POST', '/exports', { format, projectId: project.id });
    await dispatcher.drain();
    const e = (await call('GET', `/exports/${r.body.export.id}`)).body as { status: string; downloadUrl: string; rowCounts: unknown; withheld: unknown; sizeBytes: number };
    const dl = await fetch(`${base}${e.downloadUrl}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const file = join(evidenceDir, `${label}.${format}`);
    writeFileSync(file, buf);
    let validation: unknown = null;
    if (format === 'xlsx') {
      const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', join(root, 'tools', 'local', 'scripts', 'validate_xlsx.py'), file], { encoding: 'utf8' });
      validation = py.status === 0 ? JSON.parse(py.stdout) : { ok: false, error: (py.stderr || 'python/openpyxl not available').slice(0, 500) };
    } else if (format === 'json') {
      const j = JSON.parse(buf.toString('utf8'));
      validation = { ok: Array.isArray(j.posts) && j.meta?.schema === 'sss.export/v1', posts: j.posts.length, accounts: j.accounts.length };
    } else {
      const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
      validation = { ok: lines.length >= 1, rows: lines.length - 1, header: lines[0]?.split(',').slice(0, 8) };
    }
    return { status: e.status, rowCounts: e.rowCounts, withheld: e.withheld, sizeBytes: e.sizeBytes, contentType: dl.headers.get('content-type'), validation };
  };
  const denied = await exportAndValidate('xlsx', 'export-default-policy');
  steps.push({ step: 'xlsx export, default policy (Bluesky export not allowed → rows withheld)', ok: denied.status === 'SUCCEEDED' && (denied.withheld as unknown[]).length > 0 && (denied.validation as { ok: boolean }).ok, summary: denied });

  await db.dataPolicy.updateMany({ where: { providerId: 'bluesky-appview' }, data: { allowedOperations: { allowHistoricalSnapshots: false, allowDerivedMetrics: false, allowMediaProcessing: false, allowExport: true } } }); // TEST CONTROL 2
  const xlsx = await exportAndValidate('xlsx', 'export-allowed-TESTCONTROL');
  const csv = await exportAndValidate('csv', 'export-allowed-TESTCONTROL');
  const jsonE = await exportAndValidate('json', 'export-allowed-TESTCONTROL');
  steps.push({ step: 'xlsx export with export allowed (test control)', ok: xlsx.status === 'SUCCEEDED' && (xlsx.rowCounts as { posts: number }).posts > 0 && (xlsx.validation as { ok: boolean }).ok, summary: xlsx });
  steps.push({ step: 'csv export', ok: csv.status === 'SUCCEEDED' && (csv.validation as { ok: boolean }).ok, summary: csv });
  steps.push({ step: 'json export', ok: jsonE.status === 'SUCCEEDED' && (jsonE.validation as { ok: boolean }).ok, summary: jsonE });

  // 3) UI pages, rendered by a real headless browser.
  const exe = browser();
  const shots: { page: string; file: string; bytes: number }[] = [];
  if (exe) {
    const pages = ['dashboard', `project/${project.id}`, `explore?projectId=${project.id}`, 'accounts', 'jobs', 'workflows', 'exports', 'sources'];
    for (const p of pages) {
      const name = p.split(/[/?]/)[0]!;
      const file = join(evidenceDir, `ui-${name}.png`);
      // Async spawn: the API serving the page runs in THIS process, so a blocking spawnSync would starve it.
      await new Promise<void>((ok) => {
        const child = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(dataDir, 'browser')}`, '--window-size=1440,1100', '--virtual-time-budget=8000', `--screenshot=${file}`, `${base}/#/${p}`], { stdio: 'ignore' });
        const t = setTimeout(() => child.kill(), 60_000);
        child.on('exit', () => (clearTimeout(t), ok()));
      });
      shots.push({ page: name, file: file.replace(root, '.'), bytes: existsSync(file) ? (await import('node:fs')).statSync(file).size : 0 });
    }
  }
  steps.push({ step: 'UI pages rendered (headless browser screenshots)', ok: !!exe && shots.every((s) => s.bytes > 10_000), summary: exe ? shots : 'no Edge/Chrome found' });

  const report = redactDeep({
    schema: 'sss.phase5-e2e/v1',
    kind: 'REAL DATA — live Bluesky calls, real web UI, independent workbook validation (openpyxl)',
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, browser: exe ? exe.split(/[\\/]/).pop() : null },
    testControls: [
      'The script approves the 2 best-scored candidates (a person does this in the product).',
      'allowExport=true was set for Bluesky in the throwaway database only, after the default-policy export, to prove the workbook with real rows. The product keeps deny-by-default until the Product Owner approves the policy.',
    ],
    privateArtifacts: 'Workbooks and screenshots contain third-party content: kept in .data/evidence/ (git-ignored), not committed.',
    steps,
    checks: Object.fromEntries(steps.map((s) => [s.step, s.ok])),
  });
  mkdirSync(join(root, 'docs', 'phase5', 'e2e'), { recursive: true });
  const out = join(root, 'docs', 'phase5', 'e2e', `${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}`);
  console.log('report:', out);
  console.log('private evidence:', evidenceDir);
  await app.close();
  await db.$disconnect();
  if (!steps.every((s) => s.ok)) process.exitCode = 1;
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
