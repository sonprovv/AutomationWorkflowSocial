import { CollectorError, toCollectorError } from '@sss/collector-core';
import { accountSyncPayload, discoverPayload, exportPayload, idempotencyKey, JOB_NAMES, metricsRefreshPayload, PAYLOAD_SCHEMAS, providerHealthPayload, unrecoverable, type JobName, type JobProcessor } from '@sss/queue';
import { AppError } from '@sss/shared';
import type { ServiceContext } from './context.ts';
import { CleanupService } from './cleanup.ts';
import { ExportService } from './exports.ts';
import { DiscoveryService } from './discovery.ts';
import { JobService } from './jobs.ts';
import { MetricsRefreshService } from './metrics.ts';
import { ProviderService } from './providers.ts';
import { SyncService } from './sync.ts';

/**
 * The single job processor used by BOTH the BullMQ worker and the inline dev/test dispatcher.
 * Status bookkeeping lives in Postgres; retry decisions follow the typed error (Master Plan §5.3):
 * transient (RATE_LIMITED / PROVIDER_UNAVAILABLE / TIMEOUT) → retry with backoff; everything else → fail now.
 */
export function createJobProcessor(ctx: ServiceContext): JobProcessor {
  const jobs = new JobService(ctx);
  const sync = new SyncService(ctx);
  const providers = new ProviderService(ctx);
  const metrics = new MetricsRefreshService(ctx);
  const discovery = new DiscoveryService(ctx);
  const cleanup = new CleanupService(ctx);
  const exportsSvc = new ExportService(ctx);

  const run: JobProcessor = async ({ jobId, name, payload, attempt, signal }) => {
    const row = await ctx.db.job.findUnique({ where: { id: jobId }, select: { maxAttempts: true } });
    if (!row) {
      ctx.logger.warn({ jobId }, 'job row missing; dropping');
      return;
    }
    if (!(await jobs.markRunning(jobId, attempt))) {
      ctx.logger.info({ jobId }, 'job cancelled or already finished; skipping');
      return;
    }
    const log = (level: 'info' | 'warn', stage: string, message: string, data?: unknown) => jobs.log(jobId, level, stage, message, data);
    await log('info', 'start', `${name} attempt ${attempt}/${row.maxAttempts}`);
    try {
      if (name === JOB_NAMES.ACCOUNT_SYNC) {
        const p = accountSyncPayload.parse(payload);
        const r = await sync.syncAccount({
          accountId: p.accountId,
          projectId: p.projectId,
          jobId,
          signal,
          isCancelled: () => jobs.isCancelRequested(jobId),
          onProgress: (pct) => jobs.progress(jobId, pct),
          onLog: log,
        });
        await jobs.finish(jobId, r.status, {
          result: r,
          warnings: r.warnings,
          errorCode: r.error?.code ?? (r.status === 'CANCELLED' ? 'CANCELLED' : null),
          errorMessage: r.error?.message ?? null,
        });
        await log('info', 'finish', `${r.status}: ${r.postsNew} new, ${r.postsUpdated} updated, ${r.pages} page(s), ${r.usage.requests} request(s)`);
        return;
      }
      if (name === JOB_NAMES.METRICS_REFRESH) {
        const p = metricsRefreshPayload.parse(payload);
        const r = await metrics.refresh({
          accountId: p.accountId,
          projectId: p.projectId,
          jobId,
          signal,
          isCancelled: () => jobs.isCancelRequested(jobId),
          onProgress: (pct) => jobs.progress(jobId, pct),
          onLog: log,
        });
        await jobs.finish(jobId, r.status, {
          result: r,
          warnings: r.warnings,
          errorCode: r.error?.code ?? (r.status === 'CANCELLED' ? 'CANCELLED' : null),
          errorMessage: r.error?.message ?? null,
        });
        await log('info', 'finish', `${r.status}: ${r.postsUpdated} updated, ${r.postsUnavailable} unavailable of ${r.postsDue} due`);
        return;
      }
      if (name === JOB_NAMES.EXPORT) {
        const { exportId } = exportPayload.parse(payload);
        const r = await exportsSvc.generate(exportId);
        await jobs.finish(jobId, 'SUCCEEDED', { result: r.export, warnings: r.warnings });
        await log('info', 'finish', `export ${r.export.format}: ${JSON.stringify(r.export.rowCounts)}; withheld ${JSON.stringify(r.export.withheld)}`);
        return;
      }
      if (name === JOB_NAMES.CLEANUP) {
        const r = await cleanup.run();
        await jobs.finish(jobId, r.status, { result: r, warnings: r.warnings });
        await log('info', 'finish', `cleanup: ${r.unavailablePostsDeleted} unavailable post(s) deleted, ${r.retention.reduce((a, x) => a + x.postsDeleted, 0)} past retention`);
        return;
      }
      if (name === JOB_NAMES.DISCOVER) {
        const p = discoverPayload.parse(payload);
        const r = await discovery.discover({
          projectId: p.projectId,
          keywordIds: p.keywordIds,
          platforms: p.platforms,
          jobId,
          signal,
          isCancelled: () => jobs.isCancelRequested(jobId),
          onProgress: (pct) => jobs.progress(jobId, pct),
          onLog: log,
        });
        await jobs.finish(jobId, r.status, {
          result: r,
          warnings: r.warnings,
          errorCode: r.error?.code ?? (r.status === 'CANCELLED' ? 'CANCELLED' : null),
          errorMessage: r.error?.message ?? null,
        });
        const c = r.candidates;
        await log('info', 'finish', `${r.status}: ${c.new} new, ${c.updated} updated candidate(s), ${c.autoApproved} auto-approved; ${r.coverage.filter((x) => x.status === 'ERROR').length} search error(s)`);
        return;
      }
      if (name === JOB_NAMES.PROVIDER_HEALTH) {
        const p = providerHealthPayload.parse(payload);
        const r = p.providerId ? [await providers.test(p.providerId)] : await providers.testAllEnabled();
        const unhealthy = r.filter((x) => !x.healthy).map((x) => x.providerId);
        await jobs.finish(jobId, unhealthy.length ? 'PARTIAL_SUCCESS' : 'SUCCEEDED', {
          result: r,
          warnings: unhealthy.map((id) => `Provider ${id} unhealthy`),
        });
        return;
      }
      throw new CollectorError('NOT_SUPPORTED', `Unknown job ${name}`);
    } catch (e) {
      const code = e instanceof AppError ? e.code : toCollectorError(e).code;
      const message = e instanceof Error ? e.message : String(e);
      const retryable = !(e instanceof AppError) && toCollectorError(e).retryable && !signal.aborted;
      if (signal.aborted) {
        // A user cancel, the job timeout and a process shutdown all abort the signal: record which one it was.
        const reason = signal.reason as { name?: string } | undefined;
        if (await jobs.isCancelRequested(jobId)) {
          await jobs.finish(jobId, 'CANCELLED', { errorCode: 'CANCELLED', errorMessage: 'Cancelled by user' });
        } else if (reason?.name === 'TimeoutError') {
          await jobs.finish(jobId, 'FAILED', { errorCode: 'TIMEOUT', errorMessage: 'Job exceeded JOB_TIMEOUT_SECONDS' });
          await log('warn', 'failed', 'TIMEOUT: job exceeded JOB_TIMEOUT_SECONDS');
        } else {
          await jobs.finish(jobId, 'CANCELLED', { errorCode: 'ABORTED', errorMessage: 'Aborted (worker shutdown); committed pages are kept' });
        }
        throw unrecoverable(new Error('aborted'));
      }
      if (retryable && attempt < row.maxAttempts) {
        await jobs.markRetrying(jobId, code, message);
        await log('warn', 'retry', `Attempt ${attempt} failed with ${code}; will retry`, { message });
        throw e instanceof Error ? e : new Error(message);
      }
      await jobs.finish(jobId, 'FAILED', { errorCode: code, errorMessage: message });
      await log('warn', 'failed', `${code}: ${message}`);
      throw unrecoverable(e instanceof Error ? e : new Error(message));
    }
  };

  /**
   * Scheduler-triggered executions arrive as BullMQ jobs named `scheduled:<job name>` without a DB row.
   * Create the DB job (same idempotency key space as manual runs: an active manual run → SKIPPED) and run it here.
   */
  return async (job) => {
    if (!job.name.startsWith('scheduled:')) return run(job);
    const name = job.name.slice('scheduled:'.length) as JobName;
    const data = (job.payload ?? {}) as Record<string, unknown>;
    const payload = PAYLOAD_SCHEMAS[name].parse(data);
    const resource =
      name === JOB_NAMES.PROVIDER_HEALTH
        ? String((payload as { providerId: string | null }).providerId ?? 'all')
        : String((payload as { accountId?: string | null }).accountId ?? `all:${(payload as { projectId?: string | null }).projectId ?? '-'}`);
    // Re-delivery of the same scheduled execution (stalled job recovered by BullMQ): resume its DB row
    // instead of skipping on the dedup conflict, which would leave that row RUNNING forever.
    const existing = await ctx.db.job.findFirst({ where: { correlationId: job.jobId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (existing) {
      await jobs.log(existing.id, 'warn', 'schedule', 'Scheduled execution re-delivered (stalled); resuming');
      return run({ ...job, jobId: existing.id, name, payload, attempt: 1 });
    }
    let created;
    try {
      created = await jobs.create({ name, payload, idempotencyKey: idempotencyKey({ op: name, resource }), dispatch: false, maxAttempts: 1, correlationId: job.jobId });
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') {
        ctx.logger.info({ name, resource }, 'scheduled run skipped: identical job already active');
        return;
      }
      throw e;
    }
    await jobs.log(created.id, 'info', 'schedule', `Triggered by schedule ${String(data.scheduleId ?? '?')}`);
    return run({ ...job, jobId: created.id, name, payload, attempt: 1 });
  };
}
