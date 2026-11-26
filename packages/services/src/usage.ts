import { CollectorError, UsageMeter, type MeterSnapshot } from '@sss/collector-core';
import { getProviderDescriptor } from '@sss/collector-registry';
import { nowOf, type ServiceContext } from './context.ts';

/** Reservation behind each meter handed out by `meterFor` (settled by `record`). */
const reservationOf = new WeakMap<UsageMeter, string>();

/** Extra lifetime of a reservation beyond the job timeout before it is considered abandoned. */
const RESERVATION_GRACE_MS = 5 * 60_000;

/**
 * Quota/budget guard (Master Plan §9.1 authorize → reserve → execute → reconcile), per provider and UTC day.
 *
 *  - authorize + reserve: `meterFor` takes a PostgreSQL advisory lock for (provider, unit, day), sums the
 *    usage already recorded plus active reservations, and reserves min(remaining, perOperationCap). Concurrent
 *    workers therefore cannot reserve more than the daily cap together.
 *  - execute: the adapter's UsageMeter refuses any call beyond the reservation (BUDGET_EXCEEDED before the call).
 *  - reconcile: `record` writes the actual usage and settles the reservation in one transaction.
 *  - Reservations of crashed workers expire (job timeout + 5 min) and stop counting.
 * Monetary project budgets need a provider cost model; every enabled provider costs $0 today, so the daily
 * unit caps are the binding limits (ADR-0012).
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

  async reservedToday(providerId: string, unit: string): Promise<number> {
    const r = await this.ctx.db.usageReservation.aggregate({
      where: { providerId, unit, day: this.day(), settledAt: null, expiresAt: { gt: nowOf(this.ctx) } },
      _sum: { amount: true },
    });
    return r._sum.amount ?? 0;
  }

  /** Meter for one operation, backed by an atomic reservation of min(remaining daily allowance, perOperationCap). */
  async meterFor(providerId: string, perOperationCap: number, ref: { projectId?: string | null; jobId?: string | null } = {}): Promise<UsageMeter> {
    const d = getProviderDescriptor(providerId);
    const cap = d.dailyCap(this.ctx.config);
    const unit = d.usageUnit;
    const day = this.day();
    const now = nowOf(this.ctx);
    const lockKey = `usage:${providerId}:${unit}:${day.toISOString().slice(0, 10)}`;
    const granted = await this.ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey}))) AS l`;
      const used = (await tx.usageLog.aggregate({ where: { providerId, unit, day }, _sum: { quantity: true } }))._sum.quantity ?? 0;
      const reserved =
        (await tx.usageReservation.aggregate({ where: { providerId, unit, day, settledAt: null, expiresAt: { gt: now } }, _sum: { amount: true } }))._sum.amount ?? 0;
      const remaining = cap - used - reserved;
      if (remaining <= 0) {
        throw new CollectorError(
          'BUDGET_EXCEEDED',
          `Daily ${unit} cap reached for ${providerId} (${used} used + ${reserved} reserved of ${cap}); resets at 00:00 UTC`,
        );
      }
      const amount = Math.min(remaining, perOperationCap);
      const row = await tx.usageReservation.create({
        data: {
          providerId,
          unit,
          day,
          amount,
          projectId: ref.projectId ?? null,
          jobId: ref.jobId ?? null,
          expiresAt: new Date(now.getTime() + this.ctx.config.JOB_TIMEOUT_SECONDS * 1000 + RESERVATION_GRACE_MS),
        },
      });
      return { id: row.id, amount };
    });
    const meter =
      unit === 'quota_units'
        ? new UsageMeter({ maxQuotaUnits: granted.amount, maxRequests: perOperationCap })
        : new UsageMeter({ maxRequests: granted.amount });
    reservationOf.set(meter, granted.id);
    return meter;
  }

  /** Reconcile: record actual usage and settle the meter's reservation (if any) atomically. */
  async record(providerId: string, snap: MeterSnapshot, ref: { projectId?: string | null; jobId?: string | null }, meter?: UsageMeter): Promise<void> {
    const day = this.day();
    const rows: { unit: string; quantity: number }[] = [
      { unit: 'requests', quantity: snap.requests },
      { unit: 'records', quantity: snap.records },
    ];
    if (snap.quotaUnits) rows.push({ unit: 'quota_units', quantity: snap.quotaUnits });
    const data = rows
      .filter((r) => r.quantity > 0)
      .map((r, i) => ({ providerId, projectId: ref.projectId ?? null, jobId: ref.jobId ?? null, unit: r.unit, quantity: r.quantity, actualCost: i === 0 ? snap.costUsd : 0, day }));
    // The operation's cost is booked on exactly one row, so SUM(actual_cost) is not multiplied by the unit count.
    if (!data.length && snap.costUsd > 0) data.push({ providerId, projectId: ref.projectId ?? null, jobId: ref.jobId ?? null, unit: 'requests', quantity: 0, actualCost: snap.costUsd, day });
    const reservationId = meter ? reservationOf.get(meter) : undefined;
    const unit = getProviderDescriptor(providerId).usageUnit;
    await this.ctx.db.$transaction(async (tx) => {
      if (data.length) await tx.usageLog.createMany({ data });
      if (reservationId) {
        await tx.usageReservation.updateMany({
          where: { id: reservationId, settledAt: null },
          data: { settledAt: nowOf(this.ctx), used: unit === 'quota_units' ? snap.quotaUnits : snap.requests },
        });
      }
    });
    if (meter) reservationOf.delete(meter);
  }

  /** WF14 housekeeping: drop settled or expired reservations older than `olderThanDays`. */
  async purgeReservations(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(nowOf(this.ctx).getTime() - olderThanDays * 86400_000);
    const r = await this.ctx.db.usageReservation.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
