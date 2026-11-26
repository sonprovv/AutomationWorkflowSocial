import { z } from 'zod';
import type { Prisma } from '@sss/database';
import { idempotencyKey, JOB_NAMES, type JobName } from '@sss/queue';
import { AppError, TERMINAL_JOB_STATUSES } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { JobService, toJobView } from './jobs.ts';
import { NotificationService } from './notify.ts';
import { evaluateCondition, TEMPLATE_WEEKLY_SCAN, validateGraph, type Graph, type GraphNode } from './workflow-graph.ts';

type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
interface Step {
  status: StepStatus;
  jobIds: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}

const POLL_MS = 500;

export const workflowCreateDefSchema = z
  .object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), projectId: z.uuid().optional(), template: z.enum(['weekly-scan', 'empty']).default('weekly-scan') })
  .strict();

/**
 * Workflow builder service + executor (Phase 9). Definitions are versioned (every save = new immutable version,
 * every run pins one). The executor walks the DAG in topological order; each node queues the SAME guarded job the
 * UI/API would (dedup, budgets, policy gates apply) and waits for it. A node's onError decides whether a failure
 * stops the run or lets its successors continue. Cancellation and per-node timeouts cancel child jobs.
 */
export class WorkflowBuilderService {
  private readonly jobs: JobService;

  constructor(private readonly ctx: ServiceContext) {
    this.jobs = new JobService(ctx);
  }

  async create(input: unknown) {
    const v = workflowCreateDefSchema.parse(input);
    if (v.projectId && !(await this.ctx.db.project.findUnique({ where: { id: v.projectId }, select: { id: true } }))) throw new AppError('NOT_FOUND', `Project ${v.projectId} not found`);
    const def = await this.ctx.db.workflowDef.create({ data: { name: v.name, description: v.description, projectId: v.projectId ?? null } });
    const graph: Graph = v.template === 'weekly-scan' ? TEMPLATE_WEEKLY_SCAN : { nodes: [{ id: 'start', type: 'trigger.manual', config: {}, timeoutSeconds: 900, onError: 'stop', position: { x: 40, y: 80 } }], edges: [] };
    await this.saveVersion(def.id, graph);
    return this.get(def.id);
  }

  async list() {
    return this.ctx.db.workflowDef.findMany({ where: { status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const def = await this.ctx.db.workflowDef.findUnique({ where: { id } });
    if (!def) throw new AppError('NOT_FOUND', `Workflow ${id} not found`);
    const versions = await this.ctx.db.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { version: 'desc' }, select: { version: true, createdAt: true } });
    const current = await this.ctx.db.workflowVersion.findUnique({ where: { workflowId_version: { workflowId: id, version: def.currentVersion } } });
    return { ...def, graph: current?.graph ?? null, versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt.toISOString() })) };
  }

  async saveVersion(id: string, graph: unknown) {
    const v = validateGraph(graph);
    if (!v.ok) throw new AppError('INVALID_INPUT', 'Invalid workflow graph', { errors: v.errors });
    const def = await this.ctx.db.workflowDef.findUnique({ where: { id } });
    if (!def) throw new AppError('NOT_FOUND', `Workflow ${id} not found`);
    const version = def.currentVersion + 1;
    await this.ctx.db.$transaction([
      this.ctx.db.workflowVersion.create({ data: { workflowId: id, version, graph: v.graph as unknown as Prisma.InputJsonValue } }),
      this.ctx.db.workflowDef.update({ where: { id }, data: { currentVersion: version } }),
    ]);
    return { version, order: v.order };
  }

  async setStatus(id: string, status: 'DRAFT' | 'ENABLED' | 'PAUSED' | 'ARCHIVED') {
    await this.get(id);
    await this.ctx.db.workflowDef.update({ where: { id }, data: { status } });
    return this.get(id);
  }

  async enqueueRun(id: string, version?: number) {
    const def = await this.ctx.db.workflowDef.findUnique({ where: { id } });
    if (!def) throw new AppError('NOT_FOUND', `Workflow ${id} not found`);
    if (def.status === 'ARCHIVED' || def.status === 'PAUSED') throw new AppError('CONFLICT', `Workflow is ${def.status}`);
    if (!def.projectId) throw new AppError('INVALID_INPUT', 'Attach the workflow to a project before running it');
    const job = await this.jobs.create({
      name: JOB_NAMES.WORKFLOW_RUN,
      payload: { workflowId: id, version: version ?? def.currentVersion, trigger: 'manual' },
      idempotencyKey: idempotencyKey({ op: JOB_NAMES.WORKFLOW_RUN, resource: id, projectId: def.projectId }),
      projectId: def.projectId,
      resourceType: 'workflow',
      resourceId: id,
    });
    return toJobView(job);
  }

  async runs(id: string) {
    const rows = await this.ctx.db.workflowRun.findMany({ where: { workflowId: id }, orderBy: { startedAt: 'desc' }, take: 20 });
    return rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null }));
  }

  /** Job body for `workflow.run`. */
  async execute(o: { workflowId: string; version: number; jobId: string; isCancelled: () => Promise<boolean>; onProgress: (pct: number) => Promise<void> }) {
    const { db } = this.ctx;
    const def = await db.workflowDef.findUnique({ where: { id: o.workflowId } });
    if (!def?.projectId) throw new AppError('NOT_FOUND', 'Workflow or its project not found');
    const projectId = def.projectId;
    const ver = await db.workflowVersion.findUnique({ where: { workflowId_version: { workflowId: o.workflowId, version: o.version } } });
    if (!ver) throw new AppError('NOT_FOUND', `Version ${o.version} not found`);
    const v = validateGraph(ver.graph);
    if (!v.ok || !v.graph) throw new AppError('INVALID_INPUT', `Stored graph is invalid: ${v.errors.join('; ')}`);
    const g = v.graph;
    const steps: Record<string, Step> = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'PENDING', jobIds: [] } as Step]));
    const run = await db.workflowRun.create({ data: { workflowId: o.workflowId, version: o.version, status: 'RUNNING', steps: steps as unknown as Prisma.InputJsonValue, jobId: o.jobId } });
    const save = (status = 'RUNNING', error?: string) =>
      db.workflowRun.update({ where: { id: run.id }, data: { status, steps: steps as unknown as Prisma.InputJsonValue, error: error ?? null, ...(status !== 'RUNNING' ? { finishedAt: nowOf(this.ctx) } : {}) } });
    const branch = new Map<string, boolean>(); // if-node results
    let aborted: string | null = null;
    let done = 0;

    for (const id of v.order) {
      const node = g.nodes.find((n) => n.id === id)!;
      const step = steps[id]!;
      if (aborted) {
        step.status = 'SKIPPED';
        continue;
      }
      // Active incoming edge: predecessor finished (not SKIPPED) and, for if-edges, the branch matches.
      const inEdges = g.edges.filter((e) => e.to === id);
      const active = node.type === 'trigger.manual' || inEdges.some((e) => steps[e.from]!.status !== 'SKIPPED' && steps[e.from]!.status !== 'PENDING' && (!e.when || branch.get(e.from) === (e.when === 'true')));
      if (!active) {
        step.status = 'SKIPPED';
        await save();
        continue;
      }
      if (await o.isCancelled()) {
        aborted = 'CANCELLED';
        step.status = 'CANCELLED';
        break;
      }
      step.status = 'RUNNING';
      step.startedAt = nowOf(this.ctx).toISOString();
      await save();
      try {
        const r = await this.runNode(node, projectId, step, o.isCancelled);
        step.status = r.status;
        step.result = r.result;
        if (node.type === 'flow.if') branch.set(id, r.result === true);
        if (r.status === 'FAILED') step.error = r.error;
      } catch (e) {
        step.status = 'FAILED';
        step.error = (e as Error).message.slice(0, 500);
      }
      step.finishedAt = nowOf(this.ctx).toISOString();
      if (step.status === 'CANCELLED') aborted = 'CANCELLED';
      else if (step.status === 'FAILED' && node.onError === 'stop') aborted = `Node "${id}" failed: ${step.error ?? ''}`;
      done += 1;
      await o.onProgress(Math.round((done / g.nodes.length) * 100));
      await save();
    }
    const statuses = Object.values(steps).map((s) => s.status);
    const final = aborted === 'CANCELLED' ? 'CANCELLED' : aborted ? 'FAILED' : statuses.some((s) => s === 'FAILED' || s === 'PARTIAL_SUCCESS') ? 'PARTIAL_SUCCESS' : 'SUCCEEDED';
    await save(final, aborted && aborted !== 'CANCELLED' ? aborted : undefined);
    return { runId: run.id, status: final as 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'CANCELLED', steps, error: aborted };
  }

  private async runNode(node: GraphNode, projectId: string, step: Step, isCancelled: () => Promise<boolean>): Promise<{ status: StepStatus; result?: unknown; error?: string }> {
    const c = node.config as Record<string, unknown>;
    const deadline = Date.now() + node.timeoutSeconds * 1000;
    const queue = async (name: JobName, payload: unknown, resource: string, window?: string) => {
      try {
        const j = await this.jobs.create({ name, payload, idempotencyKey: idempotencyKey({ op: name, resource, projectId, window }), projectId, resourceType: 'workflow-node', resourceId: node.id });
        step.jobIds.push(j.id);
        return j.id;
      } catch (e) {
        // An identical job is already active: wait for that one instead of duplicating work.
        if (e instanceof AppError && e.code === 'CONFLICT' && typeof e.details?.jobId === 'string') {
          step.jobIds.push(e.details.jobId);
          return e.details.jobId;
        }
        throw e;
      }
    };
    const wait = async (ids: string[]) => {
      const results: { status: string; error: string | null; result: unknown }[] = [];
      for (const id of ids) {
        for (;;) {
          const j = await this.ctx.db.job.findUnique({ where: { id } });
          if (j && TERMINAL_JOB_STATUSES.includes(j.status)) {
            results.push({ status: j.status, error: j.errorCode ? `${j.errorCode}: ${j.errorMessage ?? ''}` : null, result: j.result });
            break;
          }
          if (await isCancelled()) {
            await this.jobs.requestCancel(id).catch(() => {});
            return { status: 'CANCELLED' as StepStatus, results };
          }
          if (Date.now() > deadline) {
            await this.jobs.requestCancel(id).catch(() => {});
            return { status: 'FAILED' as StepStatus, results, error: `TIMEOUT after ${node.timeoutSeconds}s` };
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      }
      const failed = results.filter((r) => r.status === 'FAILED');
      const status: StepStatus = failed.length === results.length && results.length ? 'FAILED' : failed.length || results.some((r) => r.status === 'PARTIAL_SUCCESS') ? 'PARTIAL_SUCCESS' : 'SUCCEEDED';
      return { status, results, error: failed[0]?.error ?? undefined };
    };
    const single = async (name: JobName, payload: unknown, window?: string) => {
      const r = await wait([await queue(name, payload, projectId, window)]);
      return { status: r.status, result: r.results[0]?.result, error: r.error };
    };

    switch (node.type) {
      case 'trigger.manual':
        return { status: 'SUCCEEDED' };
      case 'collect.discover': {
        const active = await this.ctx.db.keyword.count({ where: { projectId, status: 'ACTIVE' } });
        if (!active) return { status: 'SKIPPED', result: 'No ACTIVE keywords' };
        return single(JOB_NAMES.DISCOVER, { projectId, keywordIds: null, platforms: (c.platforms as string[] | undefined) ?? null, trigger: 'manual' });
      }
      case 'collect.sync_tracked': {
        const links = await this.ctx.db.projectAccount.findMany({ where: { projectId, trackingStatus: 'TRACKING', approvalStatus: 'APPROVED' }, take: Number(c.maxAccounts ?? 50) });
        if (!links.length) return { status: 'SKIPPED', result: 'No tracked accounts' };
        const ids: string[] = [];
        for (const l of links) {
          try {
            const j = await this.jobs.create({ name: JOB_NAMES.ACCOUNT_SYNC, payload: { accountId: l.accountId, projectId, trigger: 'manual' }, idempotencyKey: idempotencyKey({ op: JOB_NAMES.ACCOUNT_SYNC, resource: l.accountId }), projectId, resourceType: 'social_account', resourceId: l.accountId });
            ids.push(j.id);
          } catch (e) {
            if (e instanceof AppError && e.code === 'CONFLICT' && typeof e.details?.jobId === 'string') ids.push(e.details.jobId);
            else throw e;
          }
        }
        step.jobIds.push(...ids);
        const r = await wait(ids);
        return { status: r.status, result: { accounts: ids.length, statuses: r.results.map((x) => x.status) }, error: r.error };
      }
      case 'collect.metrics_refresh':
        return single(JOB_NAMES.METRICS_REFRESH, { accountId: null, projectId, trigger: 'manual' });
      case 'analytics.viral':
        return single(JOB_NAMES.VIRAL, { projectId, trigger: 'manual' });
      case 'analytics.trends':
        return single(JOB_NAMES.TRENDS, { projectId, windowDays: Number(c.windowDays ?? 7), trigger: 'manual' });
      case 'ai.analyze':
        return single(JOB_NAMES.AI_ANALYZE, { projectId, postIds: null, trigger: 'manual' });
      case 'export.file': {
        const { ExportService } = await import('./exports.ts');
        const r = await new ExportService(this.ctx).request({ format: c.format ?? 'xlsx', projectId });
        step.jobIds.push(r.job.id);
        const w = await wait([r.job.id]);
        return { status: w.status, result: { exportId: r.export.id, downloadUrl: `/api/v1/exports/${r.export.id}/download` }, error: w.error };
      }
      case 'report.generate':
        return single(JOB_NAMES.REPORT, { projectId, kind: c.kind ?? 'daily', notify: c.notify === true, trigger: 'manual' }, String(c.kind ?? 'daily'));
      case 'notify.message': {
        const res = await new NotificationService(this.ctx).send({ projectId, type: 'report', dedupKey: `workflow:${node.id}:${step.startedAt}`, title: String(c.title), body: String(c.body ?? '') });
        const failed = res.filter((x) => x.status === 'FAILED');
        return { status: failed.length && failed.length === res.filter((x) => x.status !== 'SKIPPED').length ? 'FAILED' : 'SUCCEEDED', result: res, error: failed[0]?.error };
      }
      case 'flow.wait': {
        const until = Date.now() + Number(c.seconds) * 1000;
        while (Date.now() < until) {
          if (await isCancelled()) return { status: 'CANCELLED' };
          await new Promise((r) => setTimeout(r, Math.min(POLL_MS * 2, until - Date.now())));
        }
        return { status: 'SUCCEEDED' };
      }
      case 'flow.if': {
        const cond = c.condition as Parameters<typeof evaluateCondition>[0];
        const actual = await this.metric(projectId, cond.metric);
        const result = evaluateCondition(cond, actual);
        return { status: 'SUCCEEDED', result };
      }
    }
  }

  private async metric(projectId: string, m: 'pendingCandidates' | 'newPosts24h' | 'viralLabeled' | 'previousStatus'): Promise<number | string | null> {
    const db = this.ctx.db;
    if (m === 'pendingCandidates') return db.discoveryCandidate.count({ where: { projectId, approvalStatus: 'PENDING' } });
    if (m === 'newPosts24h') return db.post.count({ where: { firstSeenAt: { gte: new Date(nowOf(this.ctx).getTime() - 86400_000) }, account: { projects: { some: { projectId } } } } });
    if (m === 'viralLabeled') return db.viralScore.count({ where: { projectId, label: { not: null } } });
    const last = await db.job.findFirst({ where: { projectId, status: { in: [...TERMINAL_JOB_STATUSES] } }, orderBy: { finishedAt: 'desc' }, select: { status: true } });
    return last?.status ?? null;
  }
}
