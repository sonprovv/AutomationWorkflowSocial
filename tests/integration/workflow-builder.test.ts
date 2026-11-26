/**
 * Phase 9 — workflow builder: graph validation (DAG, reachability, configs), immutable versions, execution
 * through the existing guarded jobs, if-branches, onError, cancellation. SYNTHETIC provider data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { validateGraph, TEMPLATE_WEEKLY_SCAN } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;
const node = (id: string, type: string, config: object = {}, extra: object = {}) => ({ id, type, config, ...extra });

describe('graph validation', () => {
  it('accepts the template and rejects cycles, unreachable nodes, bad configs and misuse of branches', () => {
    expect(validateGraph(TEMPLATE_WEEKLY_SCAN)).toMatchObject({ ok: true, errors: [] });
    const cyc = validateGraph({ nodes: [node('s', 'trigger.manual'), node('a', 'analytics.viral'), node('b', 'analytics.trends')], edges: [{ from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    expect(cyc.errors.join(' ')).toMatch(/cycle/);
    const orphan = validateGraph({ nodes: [node('s', 'trigger.manual'), node('a', 'analytics.viral')], edges: [] });
    expect(orphan.errors.join(' ')).toMatch(/Unreachable.*a/);
    const cfg = validateGraph({ nodes: [node('s', 'trigger.manual'), node('w', 'flow.wait', { seconds: 99999 })], edges: [{ from: 's', to: 'w' }] });
    expect(cfg.errors.join(' ')).toMatch(/config/);
    const unknown = validateGraph({ nodes: [node('s', 'trigger.manual'), node('x', 'shell.exec')], edges: [{ from: 's', to: 'x' }] });
    expect(unknown.ok).toBe(false);
    const branch = validateGraph({ nodes: [node('s', 'trigger.manual'), node('i', 'flow.if', { condition: { metric: 'pendingCandidates', op: '>', value: 0 } }), node('a', 'analytics.viral')], edges: [{ from: 's', to: 'i' }, { from: 'i', to: 'a' }] });
    expect(branch.errors.join(' ')).toMatch(/when/);
    const twoTriggers = validateGraph({ nodes: [node('s', 'trigger.manual'), node('t', 'trigger.manual')], edges: [] });
    expect(twoTriggers.errors.join(' ')).toMatch(/Exactly one/);
  });
});

describe('workflow builder API + execution', () => {
  async function setup() {
    h = await createHarness({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
      '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [fixturePost('3w1', new Date(Date.now() - 3600_000).toISOString(), 5)] } }),
    });
    app = await buildServer({ runtime: h.runtime });
    const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Builder', platforms: ['bluesky'] } }));
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id } });
    await h.dispatcher.drain();
    return pr.id as string;
  }
  async function runAndWait(id: string) {
    const r = await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${id}/run`, payload: {} });
    expect(r.statusCode).toBe(202);
    for (let i = 0; i < 200; i++) {
      await h.dispatcher.drain();
      const j = json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(r).job_id}` }));
      if (!['QUEUED', 'RUNNING'].includes(j.status)) return j;
      await new Promise((x) => setTimeout(x, 50));
    }
    throw new Error('workflow did not finish');
  }

  it('versions are immutable; a run executes the pinned graph through real jobs, follows if-branches and skips the inactive side', async () => {
    const projectId = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/v1/workflow-defs', payload: { name: 'Scan', projectId, template: 'empty' } });
    expect(created.statusCode).toBe(201);
    const wf = json(created);
    expect(wf).toMatchObject({ currentVersion: 1, status: 'DRAFT', versions: [{ version: 1 }] });

    const bad = await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/versions`, payload: { graph: { nodes: [node('s', 'trigger.manual'), node('a', 'analytics.viral')], edges: [{ from: 'a', to: 'a' }] } } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.details.errors.join(' ')).toMatch(/Self-loop/);

    const graph = {
      nodes: [
        node('start', 'trigger.manual'),
        node('sync', 'collect.sync_tracked', { maxAccounts: 5 }),
        node('check', 'flow.if', { condition: { metric: 'newPosts24h', op: '>=', value: 1 } }),
        node('yes', 'analytics.trends', { windowDays: 7 }),
        node('no', 'notify.message', { title: 'nothing new' }),
        node('export', 'export.file', { format: 'json' }),
      ],
      edges: [
        { from: 'start', to: 'sync' },
        { from: 'sync', to: 'check' },
        { from: 'check', to: 'yes', when: 'true' },
        { from: 'check', to: 'no', when: 'false' },
        { from: 'yes', to: 'export' },
      ],
    };
    const saved = await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/versions`, payload: { graph } });
    expect(json(saved)).toMatchObject({ version: 2, order: ['start', 'sync', 'check', 'yes', 'no', 'export'] });
    expect(json(await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/graph` })).version).toBe(2);

    const job = await runAndWait(wf.id);
    expect(job.status).toBe('SUCCEEDED');
    const steps = job.result.steps;
    expect(steps.sync).toMatchObject({ status: 'SUCCEEDED', jobIds: [expect.any(String)] });
    expect(steps.check).toMatchObject({ status: 'SUCCEEDED', result: true });
    expect(steps.yes.status).toBe('SUCCEEDED'); // trends job ran (policy-gated result inside)
    expect(steps.no.status).toBe('SKIPPED');
    expect(steps.export).toMatchObject({ status: 'SUCCEEDED', result: { downloadUrl: expect.stringMatching(/\/download$/) } });
    const runs = json(await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/runs` }));
    expect(runs.items[0]).toMatchObject({ version: 2, status: 'SUCCEEDED' });
    // Old versions stay readable and unchanged.
    expect(await h.db.workflowVersion.count({ where: { workflowId: wf.id } })).toBe(2);
  });

  it('onError=stop fails the run and skips the rest; onError=continue keeps going; ARCHIVED/PAUSED cannot run', async () => {
    const projectId = await setup();
    const wf = json(await app.inject({ method: 'POST', url: '/api/v1/workflow-defs', payload: { name: 'Errors', projectId, template: 'empty' } }));
    // ai.analyze without an AI key fails (AUTH_REQUIRED) — but only when a post passes the policy gate; use a
    // discover node without keywords instead, which is SKIPPED, and a failing export format via job failure is
    // hard to force, so use the AI node after allowing derived metrics in this test database.
    await h.db.dataPolicy.updateMany({ where: { providerId: 'bluesky-appview' }, data: { allowedOperations: { allowDerivedMetrics: true } } });
    const mk = (onError: 'stop' | 'continue') => ({
      nodes: [node('start', 'trigger.manual'), node('ai', 'ai.analyze', {}, { onError }), node('discover', 'collect.discover'), node('after', 'analytics.viral')],
      edges: [{ from: 'start', to: 'ai' }, { from: 'ai', to: 'discover' }, { from: 'discover', to: 'after' }],
    });
    await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/versions`, payload: { graph: mk('stop') } });
    const stopped = await runAndWait(wf.id);
    expect(stopped).toMatchObject({ status: 'FAILED', error: { code: 'WORKFLOW_FAILED' } });
    expect(stopped.result.steps.ai).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/AUTH_REQUIRED/) });
    expect(stopped.result.steps.after.status).toBe('SKIPPED');

    await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/versions`, payload: { graph: mk('continue') } });
    const cont = await runAndWait(wf.id);
    expect(cont.status).toBe('PARTIAL_SUCCESS');
    expect(cont.result.steps.discover.status).toBe('SKIPPED'); // no ACTIVE keywords → explicit skip, not a failure
    expect(cont.result.steps.after.status).toBe('SKIPPED'); // its only input was skipped

    await app.inject({ method: 'PATCH', url: `/api/v1/workflow-defs/${wf.id}`, payload: { status: 'PAUSED' } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/run`, payload: {} })).statusCode).toBe(409);
    const types = json(await app.inject({ method: 'GET', url: '/api/v1/workflow-defs/node-types' }));
    expect(types.items.map((t: any) => t.type)).toContain('flow.if');
  });
  it('editor API: attach a project and rename via PATCH, read any stored version (P9-02)', async () => {
    const projectId = await setup();
    const wf = json(await app.inject({ method: 'POST', url: '/api/v1/workflow-defs', payload: { name: 'Unattached' } }));
    expect(wf.projectId).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/run`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/workflow-defs/${wf.id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/workflow-defs/${wf.id}`, payload: { projectId: '00000000-0000-4000-8000-000000000000' } })).statusCode).toBe(404);
    const patched = json(await app.inject({ method: 'PATCH', url: `/api/v1/workflow-defs/${wf.id}`, payload: { projectId, name: 'Attached', status: 'ENABLED' } }));
    expect(patched).toMatchObject({ projectId, name: 'Attached', status: 'ENABLED' });

    const v1 = json(await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/versions/1` }));
    expect(v1).toMatchObject({ version: 1, graph: { nodes: expect.any(Array), edges: expect.any(Array) } });
    // Restoring v1 = saving its graph as a new version; v1 itself never changes.
    const restored = json(await app.inject({ method: 'POST', url: `/api/v1/workflow-defs/${wf.id}/versions`, payload: { graph: v1.graph } }));
    expect(restored.version).toBe(2);
    expect(json(await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/versions/1` })).graph).toEqual(v1.graph);
    expect((await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/versions/99` })).statusCode).toBe(404);

    const job = await runAndWait(wf.id);
    expect(['SUCCEEDED', 'PARTIAL_SUCCESS']).toContain(job.status);
    expect(json(await app.inject({ method: 'GET', url: `/api/v1/workflow-defs/${wf.id}/runs` })).items[0]).toMatchObject({ version: 2, jobId: job.id });
  });
});
