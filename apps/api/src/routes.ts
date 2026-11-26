import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pingDb } from '@sss/database';
import {
  AccountService,
  addKeywordsSchema,
  candidateQuerySchema,
  CandidateService,
  decideSchema,
  discoverRequestSchema,
  enqueueDiscovery,
  KeywordService,
  SchedulerService,
  keywordPatchSchema,
  createProjectSchema,
  JobService,
  PostQueryService,
  postQuerySchema,
  ProjectService,
  ProviderService,
  toJobView,
  trackAccountSchema,
  trackingPatchSchema,
  workflowCreateSchema,
  workflowPatchSchema,
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
  const keywords = new KeywordService(ctx);
  const candidates = new CandidateService(ctx);
  const scheduler = new SchedulerService(ctx);

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
  api.post('/accounts/:id/refresh-metrics', { schema: { tags: ['accounts'], params: idParam, body: z.object({ projectId: z.uuid().optional() }).strict().nullish(), description: 'Refresh allowed metrics of the account posts that are due (age-tiered). Posts the provider no longer returns are marked UNAVAILABLE.' } }, async (req, reply) => {
    const job = await accounts.enqueueMetricsRefresh(req.params.id, req.body?.projectId ?? null, 'manual');
    return accepted(reply, toJobView(job));
  });
  api.post('/metrics/refresh', { schema: { tags: ['accounts'], body: z.object({ projectId: z.uuid().optional() }).strict().nullish(), description: 'Refresh due post metrics for every tracked account (optionally one project).' } }, async (req, reply) => {
    const job = await accounts.enqueueMetricsRefresh(null, req.body?.projectId ?? null, 'manual');
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
  api.get('/jobs/stats', { schema: { tags: ['jobs'], querystring: z.object({ windowHours: z.coerce.number().int().min(1).max(720).default(24) }), description: 'Job monitor: counts, active jobs (stuck flag), dead-letter view of FAILED jobs.' } }, async (req) =>
    jobs.stats(req.query.windowHours),
  );
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

  /* ---------------- keywords & discovery (Phase 3) ---------------- */
  api.get('/projects/:id/keywords', { schema: { tags: ['discovery'], params: idParam, querystring: z.object({ status: z.enum(['SUGGESTED', 'ACTIVE', 'PAUSED', 'REJECTED']).optional() }) } }, async (req) => ({
    items: await keywords.list(req.params.id, req.query.status),
  }));
  api.post('/projects/:id/keywords', { schema: { tags: ['discovery'], params: idParam, body: addKeywordsSchema, description: 'Add manual keywords (ACTIVE). Duplicates by normalized text are returned under `existing`.' } }, async (req, reply) =>
    reply.status(201).send(await keywords.add(req.params.id, req.body)),
  );
  api.patch('/keywords/:id', { schema: { tags: ['discovery'], params: idParam, body: keywordPatchSchema } }, async (req) => keywords.update(req.params.id, req.body));
  api.delete('/keywords/:id', { schema: { tags: ['discovery'], params: idParam } }, async (req, reply) => {
    await keywords.delete(req.params.id);
    return reply.status(204).send();
  });
  api.post('/projects/:id/keywords/expand', { schema: { tags: ['discovery'], params: idParam, description: 'WF01 (rule mode): suggest variants of ACTIVE keywords as SUGGESTED; activate them with PATCH /keywords/:id.' } }, async (req, reply) => {
    const p = await projects.get(req.params.id);
    return reply.status(201).send(await keywords.expand(req.params.id, p.settings.max_keywords_per_run));
  });
  api.post('/projects/:id/discover', { schema: { tags: ['discovery'], params: idParam, body: discoverRequestSchema.nullish(), description: 'WF02: search ACTIVE keywords on the project platforms and fill the review queue. Returns 202 + job.' } }, async (req, reply) =>
    accepted(reply, toJobView(await enqueueDiscovery(ctx, req.params.id, req.body ?? {}))),
  );
  api.get('/projects/:id/candidates', { schema: { tags: ['discovery'], params: idParam, querystring: candidateQuerySchema } }, async (req) => candidates.list(req.params.id, req.query));
  api.get('/projects/:id/candidates/:candidateId', { schema: { tags: ['discovery'], params: z.object({ id: z.uuid(), candidateId: z.uuid() }) } }, async (req) => candidates.get(req.params.id, req.params.candidateId));
  api.post('/projects/:id/candidates/approve', { schema: { tags: ['discovery'], params: idParam, body: decideSchema, description: 'Approve candidates: track them in the project and queue their initial sync (sync=false to skip).' } }, async (req) => {
    const b = decideSchema.parse(req.body);
    return candidates.decide(req.params.id, b.candidateIds, 'APPROVED', 'local-user', { sync: b.sync });
  });
  api.post('/projects/:id/candidates/reject', { schema: { tags: ['discovery'], params: idParam, body: decideSchema } }, async (req) => {
    const b = decideSchema.parse(req.body);
    return candidates.decide(req.params.id, b.candidateIds, 'REJECTED', 'local-user', { sync: false });
  });

  /* ---------------- workflows & scheduler (Phase 4) ---------------- */
  const wfId = z.object({ id: z.string().regex(/^[a-z0-9-]{3,64}$/) });
  api.get('/workflows', { schema: { tags: ['workflows'], description: 'Scheduled workflows with next/last run and the scheduler pause state.' } }, async () => scheduler.list());
  api.post('/workflows', { schema: { tags: ['workflows'], body: workflowCreateSchema } }, async (req, reply) => reply.status(201).send(await scheduler.create(req.body)));
  api.patch('/workflows/:id', { schema: { tags: ['workflows'], params: wfId, body: workflowPatchSchema, description: 'Enable/disable, change interval (everyMinutes) or cron + timezone, or config.' } }, async (req) =>
    scheduler.update(req.params.id, req.body),
  );
  api.post('/workflows/:id/run', { schema: { tags: ['workflows'], params: wfId, description: 'Run the workflow now (does not move its next scheduled run).' } }, async (req) => scheduler.runNow(req.params.id));
  api.get('/scheduler', { schema: { tags: ['workflows'] } }, async () => ({ paused: await scheduler.isPaused(), tickSeconds: ctx.config.SCHEDULER_TICK_SECONDS }));
  api.post('/scheduler/pause', { schema: { tags: ['workflows'], description: 'Stop firing scheduled workflows (running jobs continue; manual runs still work).' } }, async () => scheduler.setPaused(true));
  api.post('/scheduler/resume', { schema: { tags: ['workflows'] } }, async () => scheduler.setPaused(false));

  /* ---------------- planned routes (later phases) ---------------- */
  const planned: [string, 'get' | 'post' | 'patch', string, number][] = [
    ['/posts/:id/analyze', 'post', 'AI content analysis (WF08)', 6],
    ['/analytics/viral', 'get', 'Viral results (policy-gated, WF07)', 6],
    ['/analytics/trends', 'get', 'Trend results (WF09)', 6],
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
