import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pingDb } from '@sss/database';
import {
  AccountService,
  createProjectSchema,
  JobService,
  PostQueryService,
  postQuerySchema,
  ProjectService,
  ProviderService,
  toJobView,
  trackAccountSchema,
  trackingPatchSchema,
  updateProjectSchema,
  type JobView,
  type Runtime,
} from '@sss/services';
import { JOB_STATUSES } from '@sss/shared';

type Api = FastifyInstance & { withTypeProvider<T>(): FastifyInstance };

const idParam = z.object({ id: z.uuid() });
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(500).optional() });

/** Long-running operations: HTTP 202 + job reference (Master Plan §11). */
function accepted(reply: FastifyReply, job: JobView, warnings: string[] = []) {
  return reply.status(202).send({ job_id: job.id, status: job.status, status_url: job.statusUrl, warnings, job });
}

export async function registerRoutes(app: FastifyInstance, rt: Runtime): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { ctx } = rt;
  const projects = new ProjectService(ctx);
  const accounts = new AccountService(ctx);
  const posts = new PostQueryService(ctx);
  const jobs = new JobService(ctx);
  const providers = new ProviderService(ctx);

  /* ---------------- health ---------------- */
  api.get('/health/live', { schema: { tags: ['health'] } }, async () => ({ status: 'ok', time: new Date().toISOString() }));
  api.get('/health/ready', { schema: { tags: ['health'] } }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    try {
      await pingDb(ctx.db);
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, error: (e as Error).message.slice(0, 200) };
    }
    try {
      await ctx.dispatcher.ping();
      checks.queue = { ok: true };
    } catch (e) {
      checks.queue = { ok: false, error: (e as Error).message.slice(0, 200) };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', queueDriver: ctx.dispatcher.driver, checks });
  });

  /* ---------------- projects ---------------- */
  api.get('/projects', { schema: { tags: ['projects'], querystring: pageQuery.extend({ status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional() }) } }, async (req) =>
    projects.list(req.query),
  );
  api.post('/projects', { schema: { tags: ['projects'], body: createProjectSchema } }, async (req, reply) => reply.status(201).send(await projects.create(req.body)));
  api.get('/projects/:id', { schema: { tags: ['projects'], params: idParam } }, async (req) => projects.get(req.params.id));
  api.patch('/projects/:id', { schema: { tags: ['projects'], params: idParam, body: updateProjectSchema } }, async (req) => projects.update(req.params.id, req.body));
  api.delete('/projects/:id', { schema: { tags: ['projects'], params: idParam } }, async (req, reply) => {
    await projects.delete(req.params.id);
    return reply.status(204).send();
  });

  /* ---------------- accounts ---------------- */
  api.get('/accounts', { schema: { tags: ['accounts'], querystring: pageQuery.extend({ projectId: z.uuid().optional(), platform: z.string().max(20).optional() }) } }, async (req) =>
    accounts.list(req.query),
  );
  api.post('/accounts', { schema: { tags: ['accounts'], body: trackAccountSchema, description: 'Resolve a profile URL/handle with the provider, store it, link it to a project and queue the initial sync.' } }, async (req, reply) => {
    const r = await accounts.track(req.body);
    return reply.status(r.created ? 201 : 200).send({
      account: r.account,
      created: r.created,
      job_id: r.job?.id ?? null,
      status_url: r.job?.statusUrl ?? null,
      job: r.job,
      warnings: r.warnings,
    });
  });
  api.get('/accounts/:id', { schema: { tags: ['accounts'], params: idParam } }, async (req) => accounts.get(req.params.id));
  api.post('/accounts/:id/sync', { schema: { tags: ['accounts'], params: idParam, body: z.object({ projectId: z.uuid().optional() }).strict().nullish() } }, async (req, reply) => {
    const job = await accounts.enqueueSync(req.params.id, req.body?.projectId ?? null, 'manual');
    return accepted(reply, toJobView(job));
  });
  api.patch('/accounts/:id/tracking', { schema: { tags: ['accounts'], params: idParam, body: trackingPatchSchema } }, async (req) => accounts.updateTracking(req.params.id, req.body));

  /* ---------------- posts ---------------- */
  api.get('/posts', { schema: { tags: ['posts'], querystring: postQuerySchema } }, async (req) => posts.list(req.query));
  api.get('/posts/:id', { schema: { tags: ['posts'], params: idParam } }, async (req) => posts.get(req.params.id));
  api.get('/posts/:id/metrics', { schema: { tags: ['posts'], params: idParam } }, async (req) => posts.metrics(req.params.id));

  /* ---------------- jobs ---------------- */
  api.get('/jobs', { schema: { tags: ['jobs'], querystring: z.object({ status: z.enum(JOB_STATUSES).optional(), projectId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }) } }, async (req) => ({
    items: await jobs.list(req.query),
  }));
  api.get('/jobs/:id', { schema: { tags: ['jobs'], params: idParam } }, async (req) => jobs.get(req.params.id, { withLogs: true }));
  api.post('/jobs/:id/cancel', { schema: { tags: ['jobs'], params: idParam } }, async (req) => jobs.requestCancel(req.params.id));
  api.post('/jobs/:id/retry', { schema: { tags: ['jobs'], params: idParam } }, async (req, reply) => accepted(reply, toJobView(await jobs.retry(req.params.id))));

  /* ---------------- providers & usage ---------------- */
  api.get('/providers', { schema: { tags: ['providers'] } }, async () => ({ items: await providers.list() }));
  api.post('/providers/:id/test', { schema: { tags: ['providers'], params: z.object({ id: z.string().regex(/^[a-z0-9-]{3,64}$/) }) } }, async (req) => providers.test(req.params.id));
  api.get('/usage', { schema: { tags: ['usage'] } }, async () => {
    const list = await providers.list();
    return {
      day: new Date().toISOString().slice(0, 10),
      timezoneNote: 'Daily caps use UTC days (Phase 1). Monetary costs are $0 for the enabled providers.',
      providers: list.filter((p) => p.implemented).map((p) => ({ providerId: p.id, usageToday: p.usageToday })),
    };
  });

  /* ---------------- planned routes (later phases) ---------------- */
  const planned: [string, 'get' | 'post' | 'patch', string, number][] = [
    ['/projects/:id/discover', 'post', 'Market discovery (WF02)', 3],
    ['/projects/:id/keywords/expand', 'post', 'Keyword expansion (WF01)', 3],
    ['/projects/:id/candidates', 'get', 'Discovery review queue', 3],
    ['/projects/:id/candidates/approve', 'post', 'Approve candidates', 3],
    ['/posts/:id/analyze', 'post', 'AI content analysis (WF08)', 6],
    ['/analytics/viral', 'get', 'Viral results (policy-gated, WF07)', 6],
    ['/analytics/trends', 'get', 'Trend results (WF09)', 6],
    ['/workflows', 'get', 'Workflow configs', 4],
    ['/workflows', 'post', 'Workflow configs', 4],
    ['/workflows/:id/run', 'post', 'Start workflow run', 4],
    ['/workflows/:id', 'patch', 'Schedule/enable/pause workflow', 4],
    ['/reports', 'post', 'Generate report', 7],
    ['/exports', 'post', 'Generate export', 5],
    ['/exports/:id/download', 'get', 'Download export', 5],
  ];
  for (const [url, method, what, phase] of planned) {
    api[method](url, { schema: { tags: ['planned'], description: `${what} — planned for Phase ${phase} (Master Plan §16)` } }, async (_req, reply) =>
      reply.status(501).send({ error: { code: 'NOT_SUPPORTED', message: `${what} is planned for Phase ${phase} and not implemented yet.` } }),
    );
  }
}

export type { Api };
