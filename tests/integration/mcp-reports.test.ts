/**
 * Phase 7 gate — "agent tool call → job → export/report" (Master Plan §16): a real MCP client spawns the
 * stdio MCP server (apps/mcp), which calls this app's REST API; jobs run; report + Excel come back.
 * Also: report content rules, notification delivery (fake Telegram + signed webhook), dedup.
 * SYNTHETIC provider data (fake AppView).
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeServer, type FakeServer } from '@sss/collector-core/testing';
import { findRepoRoot } from '@sss/config';
import { freePort } from '@sss/database';
import { signWebhook } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
let hooks: FakeServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await app?.close();
  await h?.close();
  await hooks?.close();
  hooks = undefined;
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

const telegram: { chat_id: string; text: string }[] = [];
const webhook: { body: string; headers: Record<string, unknown> }[] = [];
const SECRET = 'webhook-secret-for-tests-0123456789';

async function setup(opts: { channels?: boolean; failSync?: boolean } = {}) {
  telegram.length = 0;
  webhook.length = 0;
  hooks = await startFakeServer({
    '/botTEST-TOKEN/sendMessage': ({ body }) => (telegram.push(JSON.parse(body)), { body: { ok: true } }),
    '/hook': ({ body, headers }) => (webhook.push({ body, headers }), { body: { ok: true } }),
  });
  h = await createHarness(
    {
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
      '/xrpc/app.bsky.feed.getAuthorFeed': () => (opts.failSync ? { status: 503, body: {} } : { body: { feed: [fixturePost('3r1', new Date(Date.now() - 3600_000).toISOString(), 9)] } }),
    },
    opts.channels === false ? {} : { TELEGRAM_BOT_TOKEN: 'TEST-TOKEN', TELEGRAM_CHAT_ID: '42', TELEGRAM_API_BASE: hooks.baseUrl, WEBHOOK_URL: `${hooks.baseUrl}/hook`, WEBHOOK_SECRET: SECRET, PUBLIC_APP_URL: 'http://127.0.0.1:18966' },
  );
  app = await buildServer({ runtime: h.runtime });
  const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Reports', platforms: ['bluesky'] } }));
  await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id } });
  await h.dispatcher.drain();
  return pr.id as string;
}

async function report(projectId: string, notify: boolean) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/reports', payload: { projectId, kind: 'daily', notify } });
  expect(r.statusCode).toBe(202);
  await h.dispatcher.drain();
  return json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(r).job_id}` }));
}

describe('reports (WF11/12) and notifications', () => {
  it('builds a report with Excel, sends it to Telegram and a signed webhook once, and withholds non-exportable URLs', async () => {
    const projectId = await setup();
    const job = await report(projectId, true);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result.delivery).toEqual([
      { channel: 'telegram', status: 'SENT' },
      { channel: 'email', status: 'SKIPPED' },
      { channel: 'webhook', status: 'SENT' },
    ]);
    const rep = json(await app.inject({ method: 'GET', url: `/api/v1/reports/${job.result.id}` }));
    expect(rep.summary).toMatchObject({ status: 'SUCCEEDED', posts: { collected: 1 }, topPosts: { basis: expect.stringMatching(/raw public likes/) } });
    expect(rep.summary.topPosts.items[0]).toMatchObject({ likes: 9, url: null }); // Bluesky export not allowed → no URL leaves the app
    expect(rep.summary.withheldFromNotifications).toMatch(/not included/);
    expect(rep.markdown).toMatch(/^# Daily report — Reports/);
    expect((await app.inject({ method: 'GET', url: rep.exportDownloadUrl })).statusCode).toBe(200);

    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toMatchObject({ chat_id: '42', text: expect.stringMatching(/Daily report — Reports[\s\S]*New posts collected: 1/) });
    expect(telegram[0]!.text).not.toMatch(/bsky\.app\/profile\/did/);
    const w = webhook[0]!;
    const sig = `sha256=${signWebhook(SECRET, String(w.headers['x-sss-timestamp']), w.body)}`;
    expect(w.headers['x-sss-signature']).toBe(sig);
    expect(JSON.parse(w.body)).toMatchObject({ type: 'report', projectId });

    // Same period again → dedup: nothing re-sent.
    const again = await report(projectId, true);
    expect(again.result.delivery.map((d: any) => d.status)).toEqual(['DUPLICATE', 'SKIPPED', 'DUPLICATE']);
    expect(telegram).toHaveLength(1);
  });

  it('a failed source makes the report PARTIAL_SUCCESS with the reason — never "no new content"', async () => {
    const projectId = await setup({ failSync: true, channels: false });
    const job = await report(projectId, false);
    expect(job.status).toBe('PARTIAL_SUCCESS');
    const rep = json(await app.inject({ method: 'GET', url: `/api/v1/reports/${job.result.id}` }));
    expect(rep.summary.failures).toEqual([{ providerId: 'bluesky-appview', errorCode: 'PROVIDER_UNAVAILABLE', runs: 1 }]);
    expect(rep.markdown).toMatch(/PARTIAL: some sources failed/);
    expect(rep.summary.actions.join(' ')).toMatch(/failed\/partial run/);
  });
});

describe('MCP gate: agent tool call → job → export/report', () => {
  async function connect(apiUrl: string, allowMutations: boolean) {
    const root = findRepoRoot();
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'apps', 'mcp', 'src', 'main.ts')],
        cwd: root,
        env: { ...(process.env as Record<string, string>), MCP_API_URL: apiUrl, MCP_ALLOW_MUTATIONS: String(allowMutations) },
        stderr: 'ignore',
      }),
    );
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };
  async function waitJob(c: Client, jobId: string) {
    for (let i = 0; i < 100; i++) {
      await h.dispatcher.drain();
      const j = await call(c, 'get_job_status', { job_id: jobId });
      if (!['QUEUED', 'RUNNING'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('job did not finish');
  }

  it('read-only by default; with mutations enabled an agent queues a report and an export and gets the files', async () => {
    const projectId = await setup({ channels: false });
    const port = await freePort();
    await app.listen({ host: '127.0.0.1', port });
    const api = `http://127.0.0.1:${port}`;

    const ro = await connect(api, false);
    const roTools = (await ro.listTools()).tools.map((t) => t.name);
    expect(roTools).toEqual(expect.arrayContaining(['get_posts', 'find_trends', 'get_job_status', 'get_provider_capabilities']));
    expect(roTools).not.toContain('export_excel');
    expect((await ro.listTools()).tools.find((t) => t.name === 'get_posts')!.annotations).toMatchObject({ readOnlyHint: true });
    const posts = await call(ro, 'get_posts', { project_id: projectId });
    expect(posts.items).toHaveLength(1);
    await ro.close();

    const agent = await connect(api, true);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['export_excel', 'generate_report', 'discover_competitors', 'track_account']));
    const rq = await call(agent, 'generate_report', { project_id: projectId, kind: 'weekly' });
    expect(rq).toMatchObject({ status: 'QUEUED', job_id: expect.any(String) });
    const rj = await waitJob(agent, rq.job_id);
    expect(rj.status).toBe('SUCCEEDED');
    const rep = await call(agent, 'get_report', { report_id: rj.result.id });
    expect(rep).toMatchObject({ kind: 'weekly', exportDownloadUrl: expect.stringMatching(/\/download$/) });

    const ex = await call(agent, 'export_excel', { project_id: projectId, format: 'xlsx' });
    const ej = await waitJob(agent, ex.job_id);
    expect(ej.status).toBe('SUCCEEDED');
    const exp = await call(agent, 'get_export', { export_id: ex.export.id });
    expect(exp.downloadUrl).toMatch(new RegExp(`^${api}/api/v1/exports/.+/download$`));
    const file = await fetch(exp.downloadUrl);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

    // Guards still apply through MCP: an unknown project is a typed error, not a crash.
    await expect(call(agent, 'export_excel', { project_id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/NOT_FOUND/);
  });
});
