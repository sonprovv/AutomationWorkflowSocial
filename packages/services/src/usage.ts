import { CollectorError, UsageMeter, type MeterSnapshot } from '@sss/collector-core';
import { getProviderDescriptor } from '@sss/collector-registry';
import { nowOf, type ServiceContext } from './context.ts';

/**
 * Phase 1 quota guard: per-provider DAILY cap (UTC day) from usage_logs, enforced by giving each
 * operation a UsageMeter capped at the remaining allowance. Concurrent workers can still overshoot by at
 * most one operation's cap — the atomic DB reservation engine (authorize → reserve → execute → reconcile,
 * Master Plan §9.1) replaces this in Phase 4.
 */
export class UsageGuard {
  constructor(private readonly ctx: ServiceContext) {}

  private day(): Date {
    const d = nowOf(this.ctx);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  async usedToday(providerId: string, unit: string): Promise<number> {
    const r = await this.ctx.db.usageLog.aggregate({ where: { providerId, unit, day: this.day() }, _sum: { quantity: true } });
    return r._sum.quantity ?? 0;
  }

  /** Meter for one operation, capped at min(remaining daily allowance, perOperationCap). */
  async meterFor(providerId: string, perOperationCap: number): Promise<UsageMeter> {
    const d = getProviderDescriptor(providerId);
    const cap = d.dailyCap(this.ctx.config);
    const used = await this.usedToday(providerId, d.usageUnit);
    const remaining = cap - used;
    if (remaining <= 0) {
      throw new CollectorError('BUDGET_EXCEEDED', `Daily ${d.usageUnit} cap reached for ${providerId} (${used}/${cap}); resets at 00:00 UTC`);
    }
    const limit = Math.min(remaining, perOperationCap);
    return d.usageUnit === 'quota_units'
      ? new UsageMeter({ maxQuotaUnits: limit, maxRequests: perOperationCap })
      : new UsageMeter({ maxRequests: limit });
  }

  async record(providerId: string, snap: MeterSnapshot, ref: { projectId?: string | null; jobId?: string | null }): Promise<void> {
    const day = this.day();
    const rows: { unit: string; quantity: number }[] = [
      { unit: 'requests', quantity: snap.requests },
      { unit: 'records', quantity: snap.records },
    ];
    if (snap.quotaUnits) rows.push({ unit: 'quota_units', quantity: snap.quotaUnits });
    const data = rows
      .filter((r) => r.quantity > 0)
      .map((r) => ({ providerId, projectId: ref.projectId ?? null, jobId: ref.jobId ?? null, unit: r.unit, quantity: r.quantity, actualCost: snap.costUsd, day }));
    if (data.length) await this.ctx.db.usageLog.createMany({ data });
  }
}
