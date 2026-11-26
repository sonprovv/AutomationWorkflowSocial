import { redactDeep } from '@sss/collector-core';
import type { Job, JobStatus as DbJobStatus, Prisma } from '@sss/database';
import { JOB_QUEUE, PAYLOAD_SCHEMAS, type JobName } from '@sss/queue';
import { AppError, TERMINAL_JOB_STATUSES, type JobStatus } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { iso, isUniqueViolation } from './serialize.ts';

export interface CreateJobInput {
  name: JobName;
  payload: unknown;
  idempotencyKey: string;
  projectId?: string | null;
  resourceType?: string;
  resourceId?: string;
  maxAttempts?: number;
  retryOfId?: string;
  /** false = only create the DB row (the caller executes it, e.g. a scheduler-triggered run in the worker). */
  dispatch?: boolean;
}

export interface JobView {
  id: string;
  name: string;
  queue: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  result: unknown;
  warnings: string[];
  error: { code: string; message: string | null } | null;
  cancelRequested: boolean;
  retryOfId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  statusUrl: string;
  logs?: { ts: string; level: string; stage: string; message: string; data: unknown }[];
}

export function toJobView(j: Job, logs?: { ts: Date; level: string; stage: string; message: string; data: unknown }[]): JobView {
  return {
    id: j.id,
    name: j.name,
    queue: j.queue,
    status: j.status,
    progress: j.progress,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    projectId: j.projectId,
    resourceType: j.resourceType,
    resourceId: j.resourceId,
    result: j.result,
    warnings: j.warnings,
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage } : null,
    cancelRequested: j.cancelRequested,
    retryOfId: j.retryOfId,
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
    statusUrl: `/api/v1/jobs/${j.id}`,
    ...(logs ? { logs: logs.map((l) => ({ ts: l.ts.toISOString(), level: l.level, stage: l.stage, message: l.message, data: l.data })) } : {}),
  };
}

/**
 * Job lifecycle in PostgreSQL (source of truth for status/progress/errors), mirrored to the queue.
 * Dedup: the partial unique index allows only one QUEUED/RUNNING job per idempotency key.
 */
export class JobService {
  constructor(private readonly ctx: ServiceContext) {}

  async create(input: CreateJobInput): Promise<Job> {
    const payload = PAYLOAD_SCHEMAS[input.name].parse(input.payload);
    const maxAttempts = input.maxAttempts ?? this.ctx.config.MAX_RETRIES + 1;
    let job: Job;
    try {
      job = await this.ctx.db.job.create({
        data: {
          queue: JOB_QUEUE[input.name],
          name: input.name,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId ?? null,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          payload: payload as Prisma.InputJsonValue,
          maxAttempts,
          retryOfId: input.retryOfId,
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const active = await this.ctx.db.job.findFirst({
        where: { idempotencyKey: input.idempotencyKey, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      throw new AppError('CONFLICT', 'An identical job is already queued or running', { jobId: active?.id ?? null });
    }
    if (input.dispatch === false) return job;
    try {
      await this.ctx.dispatcher.dispatch({ jobId: job.id, name: input.name, payload, attempts: maxAttempts });
    } catch (e) {
      await this.finish(job.id, 'FAILED', { errorCode: 'SERVICE_UNAVAILABLE', errorMessage: `Queue unavailable: ${(e as Error).message}` });
      throw new AppError('SERVICE_UNAVAILABLE', 'Job queue is unavailable (is Redis running?)', { jobId: job.id });
    }
    return job;
  }

  /** Returns false if the job must not run (cancelled / already terminal). */
  async markRunning(jobId: string, attempt: number): Promise<boolean> {
    const r = await this.ctx.db.job.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] }, cancelRequested: false },
      data: { status: 'RUNNING', attempts: attempt, startedAt: nowOf(this.ctx) },
    });
    if (r.count === 0) {
      const j = await this.ctx.db.job.findUnique({ where: { id: jobId } });
      if (j && j.cancelRequested && !TERMINAL_JOB_STATUSES.includes(j.status)) {
        await this.finish(jobId, 'CANCELLED', { errorCode: 'CANCELLED', errorMessage: 'Cancelled before start' });
      }
      return false;
    }
    return true;
  }

  async progress(jobId: string, progress: number): Promise<void> {
    await this.ctx.db.job.update({ where: { id: jobId }, data: { progress: Math.max(0, Math.min(100, Math.round(progress))) } });
  }

  /** Back to QUEUED between retry attempts (BullMQ will re-deliver after backoff). */
  async markRetrying(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.ctx.db.job.update({ where: { id: jobId }, data: { status: 'QUEUED', errorCode, errorMessage } });
  }

  async finish(
    jobId: string,
    status: Exclude<DbJobStatus, 'QUEUED' | 'RUNNING'>,
    extra: { result?: unknown; warnings?: string[]; errorCode?: string | null; errorMessage?: string | null } = {},
  ): Promise<void> {
    await this.ctx.db.job.update({
      where: { id: jobId },
      data: {
        status,
        finishedAt: nowOf(this.ctx),
        progress: status === 'SUCCEEDED' ? 100 : undefined,
        result: extra.result === undefined ? undefined : (redactDeep(extra.result) as Prisma.InputJsonValue),
        warnings: extra.warnings ? [...new Set(extra.warnings)].slice(0, 50) : undefined,
        errorCode: extra.errorCode === undefined ? undefined : extra.errorCode,
        errorMessage: extra.errorMessage === undefined ? undefined : extra.errorMessage?.slice(0, 2000),
      },
    });
  }

  async log(jobId: string, level: 'debug' | 'info' | 'warn' | 'error', stage: string, message: string, data?: unknown): Promise<void> {
    await this.ctx.db.jobLog.create({
      data: { jobId, level, stage, message: message.slice(0, 2000), data: data === undefined ? undefined : (redactDeep(data) as Prisma.InputJsonValue) },
    });
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    const j = await this.ctx.db.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
    return j?.cancelRequested ?? true;
  }

  async get(jobId: string, opts: { withLogs?: boolean } = {}): Promise<JobView> {
    const j = await this.ctx.db.job.findUnique({ where: { id: jobId } });
    if (!j) throw new AppError('NOT_FOUND', `Job ${jobId} not found`);
    const logs = opts.withLogs ? await this.ctx.db.jobLog.findMany({ where: { jobId }, orderBy: { ts: 'asc' }, take: 200 }) : undefined;
    return toJobView(j, logs);
  }

  async list(filter: { status?: JobStatus; projectId?: string; limit?: number }): Promise<JobView[]> {
    const rows = await this.ctx.db.job.findMany({
      where: { status: filter.status, projectId: filter.projectId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
    });
    return rows.map((r) => toJobView(r));
  }

  async requestCancel(jobId: string): Promise<JobView> {
    const j = await this.ctx.db.job.findUnique({ where: { id: jobId } });
    if (!j) throw new AppError('NOT_FOUND', `Job ${jobId} not found`);
    if (TERMINAL_JOB_STATUSES.includes(j.status)) throw new AppError('CONFLICT', `Job is already ${j.status}`, { jobId });
    await this.ctx.db.job.update({ where: { id: jobId }, data: { cancelRequested: true } });
    const outcome = await this.ctx.dispatcher.cancel(jobId, j.name as JobName).catch(() => 'not_found' as const);
    if (outcome === 'removed' || (outcome === 'not_found' && j.status === 'QUEUED')) {
      await this.finish(jobId, 'CANCELLED', { errorCode: 'CANCELLED', errorMessage: 'Cancelled by user' });
    }
    await this.log(jobId, 'info', 'cancel', `Cancel requested (queue outcome: ${outcome})`);
    return this.get(jobId);
  }

  async retry(jobId: string): Promise<Job> {
    const j = await this.ctx.db.job.findUnique({ where: { id: jobId } });
    if (!j) throw new AppError('NOT_FOUND', `Job ${jobId} not found`);
    if (!['FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(j.status)) {
      throw new AppError('CONFLICT', `Only FAILED, CANCELLED or PARTIAL_SUCCESS jobs can be retried (status: ${j.status})`, { jobId });
    }
    const payload = { ...(j.payload as Record<string, unknown>), ...(j.name === 'account.sync' ? { trigger: 'retry' } : {}) };
    return this.create({
      name: j.name as JobName,
      payload,
      idempotencyKey: j.idempotencyKey,
      projectId: j.projectId,
      resourceType: j.resourceType ?? undefined,
      resourceId: j.resourceId ?? undefined,
      maxAttempts: j.maxAttempts,
      retryOfId: j.id,
    });
  }
}
