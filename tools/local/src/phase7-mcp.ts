#!/usr/bin/env node
/**
 * Phase 7 gate with REAL data: an MCP client (stand-in for an AI agent) spawns apps/mcp over stdio; the MCP
 * server calls this app's REST API; real Bluesky discovery, tracking, report and Excel export run as jobs.
 *
 *   npm run phase7:mcp
 *
 * Ephemeral embedded PostgreSQL + inline dispatcher + the real API on a free port. Notifications are not
 * configured here (no real Telegram/email is contacted). The committed report holds tool names, job statuses
 * and counts only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { redactDeep } from '@sss/collector-core';
import { configSchema, findRepoRoot } from '@sss/config';
import { createDb, freePort, migrateDeploy, startEmbeddedPostgres } from '@sss/database';
import { InlineDispatcher } from '@sss/queue';
import { createRuntime, seedFromCapabilityRecords } from '@sss/services';
import { buildServer } from '../../../apps/api/src/server.ts';

const root = findRepoRoot();
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-');
const dataDir = mkdtempSync(join(tmpdir(), 'sss-phase7-pg-'));
const steps: { step: string; ok: boolean; summary?: unknown }[] = [];
const pg = await startEmbeddedPostgres({ dataDir, password: 'phase7-ephemeral', persistent: false });
let client: Client | null = null;
try {
  await migrateDeploy(pg.url);
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', SMTP_URL: '', WEBHOOK_URL: '' };
  const config = configSchema.parse({ ...env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent', EXPORT_DIR: join(dataDir, 'exports') });
  const db = createDb(pg.url);
  await seedFromCapabilityRecords(db);
  const dispatcher = new InlineDispatcher();
  const app = await buildServer({ runtime: createRuntime(config, { db, dispatcher }) });
  const port = await freePort();
  await app.listen({ host: '127.0.0.1', port });
  const api = `http://127.0.0.1:${port}`;

  client = new Client({ name: 'phase7-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'apps', 'mcp', 'src', 'main.ts')],
      cwd: root,
      env: { ...(env as Record<string, string>), MCP_API_URL: api, MCP_ALLOW_MUTATIONS: 'true' },
      stderr: 'ignore',
    }),
  );
  const c = client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };
  const wait = async (jobId: string) => {
    for (let i = 0; i < 600; i++) {
      await dispatcher.drain();
      const j = await call('get_job_status', { job_id: jobId });
      if (!['QUEUED', 'RUNNING'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`job ${jobId} did not finish`);
  };

  const tools = (await c.listTools()).tools.map((t) => t.name).sort();
  steps.push({ step: 'MCP server lists tools (mutations enabled)', ok: tools.includes('discover_competitors') && tools.includes('export_excel'), summary: { count: tools.length, tools } });
  const project = await call('create_project', { name: 'Phase 7 via MCP (real data)', platforms: ['bluesky'], languages: ['en'] });
  const disc = await call('discover_competitors', { project_id: project.id, keywords: ['live wallpaper'] });
  const dj = await wait(disc.job_id);
  steps.push({ step: 'discover_competitors → job (real Bluesky)', ok: ['SUCCEEDED', 'PARTIAL_SUCCESS'].includes(dj.status), summary: { status: dj.status, candidates: dj.result?.candidates } });
  const cands = await call('list_candidates', { project_id: project.id, limit: 2 });
  const ap = await call('approve_candidates', { project_id: project.id, candidate_ids: cands.items.map((x: { id: string }) => x.id) });
  for (const a of ap.approved) if (a.job) await wait(a.job.id);
  const tr = await call('track_account', { input: 'https://bsky.app/profile/bsky.app', project_id: project.id });
  if (tr.job_id) await wait(tr.job_id);
  const posts = await call('get_posts', { project_id: project.id, limit: 5 });
  steps.push({ step: 'approve_candidates + track_account → syncs → get_posts', ok: posts.items.length > 0, summary: { approved: ap.approved.length, postsReturned: posts.items.length } });
  const rq = await call('generate_report', { project_id: project.id, kind: 'daily' });
  const rj = await wait(rq.job_id);
  const rep = await call('get_report', { report_id: rj.result.id });
  steps.push({ step: 'generate_report → job → report + Excel', ok: ['SUCCEEDED', 'PARTIAL_SUCCESS'].includes(rj.status) && !!rep.exportDownloadUrl, summary: { status: rj.status, reportStatus: rep.status, postsCollected: rep.summary.posts.collected, actions: rep.summary.actions.length } });
  const ex = await call('export_excel', { project_id: project.id, format: 'xlsx' });
  await wait(ex.job_id);
  const exp = await call('get_export', { export_id: ex.export.id });
  const file = await fetch(exp.downloadUrl);
  const bytes = Buffer.from(await file.arrayBuffer());
  steps.push({ step: 'export_excel → job → downloadable workbook', ok: file.status === 200 && bytes.subarray(0, 2).toString() === 'PK', summary: { status: exp.status, rowCounts: exp.rowCounts, withheld: exp.withheld, bytes: bytes.length } });
  const caps = await call('get_provider_capabilities');
  steps.push({ step: 'read-only tool through MCP', ok: Array.isArray(caps.items) && caps.items.length === 10 });

  const report = redactDeep({
    schema: 'sss.phase7-mcp/v1',
    kind: 'REAL DATA — MCP stdio client → MCP server → REST API → jobs (live Bluesky)',
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    testControls: ['The agent approves the 2 best-scored candidates.', 'No notification channel is configured in this run.'],
    steps,
    checks: Object.fromEntries(steps.map((s) => [s.step, s.ok])),
  });
  mkdirSync(join(root, 'docs', 'phase7'), { recursive: true });
  const out = join(root, 'docs', 'phase7', `${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}`);
  console.log('report:', out);
  await client.close();
  client = null;
  await app.close();
  await db.$disconnect();
  if (!steps.every((s) => s.ok)) process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
