import type { ServiceContext } from './context.ts';
import { nowOf } from './context.ts';

/**
 * Observability (Master Plan §15, Phase 8): in-process HTTP metrics + database gauges, exposed in the
 * Prometheus text format at GET /api/v1/metrics. No external dependency; scrape it or read it by hand.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class HttpMetrics {
  private readonly counts = new Map<string, number>();
  private readonly hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  readonly startedAt = Date.now();

  observe(method: string, route: string, status: number, seconds: number) {
    const key = `${method}|${route}|${Math.floor(status / 100)}xx`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const hk = `${method}|${route}`;
    const h = this.hist.get(hk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.hist.set(hk, h);
  }

  render(): string[] {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = ['# HELP sss_http_requests_total HTTP requests by route and status class', '# TYPE sss_http_requests_total counter'];
    for (const [k, v] of this.counts) {
      const [m, r, s] = k.split('|');
      out.push(`sss_http_requests_total{method="${m}",route="${esc(r!)}",status="${s}"} ${v}`);
    }
    out.push('# HELP sss_http_request_duration_seconds HTTP latency', '# TYPE sss_http_request_duration_seconds histogram');
    for (const [k, h] of this.hist) {
      const [m, r] = k.split('|');
      const l = `method="${m}",route="${esc(r!)}"`;
      BUCKETS.forEach((b, i) => out.push(`sss_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      out.push(`sss_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `sss_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `sss_http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    out.push('# HELP sss_process_uptime_seconds Process uptime', '# TYPE sss_process_uptime_seconds gauge', `sss_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);
    out.push('# HELP sss_process_resident_memory_bytes RSS', '# TYPE sss_process_resident_memory_bytes gauge', `sss_process_resident_memory_bytes ${process.memoryUsage().rss}`);
    return out;
  }
}

export async function databaseMetrics(ctx: ServiceContext): Promise<string[]> {
  const { db } = ctx;
  const now = nowOf(ctx);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [jobs, failed24h, posts, accounts, usage, reserved, runs, paused, oldestQueued] = await Promise.all([
    db.job.groupBy({ by: ['status'], where: { status: { in: ['QUEUED', 'RUNNING'] } }, _count: { _all: true } }),
    db.job.groupBy({ by: ['name'], where: { status: 'FAILED', finishedAt: { gte: new Date(now.getTime() - 86400_000) } }, _count: { _all: true } }),
    db.post.groupBy({ by: ['status'], _count: { _all: true } }),
    db.socialAccount.count(),
    db.usageLog.groupBy({ by: ['providerId', 'unit'], where: { day }, _sum: { quantity: true, actualCost: true } }),
    db.usageReservation.groupBy({ by: ['providerId', 'unit'], where: { day, settledAt: null, expiresAt: { gt: now } }, _sum: { amount: true } }),
    db.collectionRun.groupBy({ by: ['providerId', 'status'], where: { startedAt: { gte: new Date(now.getTime() - 86400_000) } }, _count: { _all: true } }),
    db.appSetting.findUnique({ where: { key: 'scheduler' } }),
    db.job.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const out: string[] = [];
  const g = (name: string, help: string, type = 'gauge') => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  g('sss_jobs_active', 'Jobs currently queued or running');
  for (const s of ['QUEUED', 'RUNNING']) out.push(`sss_jobs_active{status="${s}"} ${jobs.find((j) => j.status === s)?._count._all ?? 0}`);
  g('sss_jobs_oldest_queued_seconds', 'Age of the oldest queued job (0 if none)');
  out.push(`sss_jobs_oldest_queued_seconds ${oldestQueued ? Math.round((now.getTime() - oldestQueued.createdAt.getTime()) / 1000) : 0}`);
  g('sss_jobs_failed_24h', 'Failed jobs in the last 24 h by job name');
  for (const f of failed24h) out.push(`sss_jobs_failed_24h{name="${f.name}"} ${f._count._all}`);
  g('sss_posts', 'Stored posts by status');
  for (const p of posts) out.push(`sss_posts{status="${p.status}"} ${p._count._all}`);
  g('sss_accounts', 'Stored accounts');
  out.push(`sss_accounts ${accounts}`);
  g('sss_provider_usage_today', 'Provider usage today (UTC) by unit');
  for (const u of usage) out.push(`sss_provider_usage_today{provider="${u.providerId}",unit="${u.unit}"} ${u._sum.quantity ?? 0}`);
  g('sss_provider_cost_usd_today', 'Recorded cost today (UTC)');
  for (const p of new Set(usage.map((u) => u.providerId))) out.push(`sss_provider_cost_usd_today{provider="${p}"} ${usage.filter((u) => u.providerId === p).reduce((a, u) => a + Number(u._sum.actualCost ?? 0), 0)}`);
  g('sss_provider_reserved_today', 'Active budget reservations');
  for (const r of reserved) out.push(`sss_provider_reserved_today{provider="${r.providerId}",unit="${r.unit}"} ${r._sum.amount ?? 0}`);
  g('sss_collection_runs_24h', 'Provider operations in the last 24 h by status');
  for (const r of runs) out.push(`sss_collection_runs_24h{provider="${r.providerId}",status="${r.status}"} ${r._count._all}`);
  g('sss_scheduler_paused', '1 when the scheduler is paused');
  out.push(`sss_scheduler_paused ${(paused?.value as { paused?: boolean } | undefined)?.paused ? 1 : 0}`);
  return out;
}
