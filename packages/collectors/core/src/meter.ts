import { CollectorError } from './errors.ts';

/**
 * Per-run usage meter with hard caps (Phase 0 harness version of the budget guard, Master Plan §9.1).
 *
 * Flow: reserve(units) BEFORE calling a provider -> call -> commit()/release().
 * Reservation is synchronous so concurrent async callers in one process cannot overspend.
 * The full multi-worker atomic budget engine (DB-backed) is a Phase 4 deliverable.
 */
export interface MeterLimits {
  maxRequests?: number;
  maxQuotaUnits?: number;
  maxCostUsd?: number;
}

export interface MeterSnapshot {
  requests: number;
  quotaUnits: number;
  costUsd: number;
  records: number;
  reservedQuotaUnits: number;
  reservedCostUsd: number;
  limits: MeterLimits;
}

export interface Reservation {
  readonly quotaUnits: number;
  readonly costUsd: number;
  commit(actual?: { quotaUnits?: number; costUsd?: number }): void;
  release(): void;
}

export class UsageMeter {
  private requests = 0;
  private quotaUnits = 0;
  private costUsd = 0;
  private records = 0;
  private reservedUnits = 0;
  private reservedCost = 0;
  private reservedRequests = 0;

  constructor(private readonly limits: MeterLimits = {}) {}

  /**
   * Reserve capacity for one provider request. Throws BUDGET_EXCEEDED if any cap would be exceeded.
   * (Provider-side daily quota exhaustion is reported separately as QUOTA_EXCEEDED by the adapter.)
   */
  reserve(opts: { quotaUnits?: number; costUsd?: number } = {}): Reservation {
    const units = opts.quotaUnits ?? 0;
    const cost = opts.costUsd ?? 0;
    const { maxRequests, maxQuotaUnits, maxCostUsd } = this.limits;
    if (maxRequests !== undefined && this.requests + this.reservedRequests + 1 > maxRequests) {
      throw new CollectorError('BUDGET_EXCEEDED', `Run request cap reached (${maxRequests})`);
    }
    if (maxQuotaUnits !== undefined && this.quotaUnits + this.reservedUnits + units > maxQuotaUnits) {
      throw new CollectorError(
        'BUDGET_EXCEEDED',
        `Run quota-unit cap reached: used=${this.quotaUnits} reserved=${this.reservedUnits} next=${units} cap=${maxQuotaUnits}`,
      );
    }
    if (maxCostUsd !== undefined && this.costUsd + this.reservedCost + cost > maxCostUsd) {
      throw new CollectorError('BUDGET_EXCEEDED', `Run cost cap reached ($${maxCostUsd})`);
    }
    this.reservedUnits += units;
    this.reservedCost += cost;
    this.reservedRequests += 1;
    let settled = false;
    const settle = () => {
      if (settled) throw new Error('Reservation already settled');
      settled = true;
      this.reservedUnits -= units;
      this.reservedCost -= cost;
      this.reservedRequests -= 1;
    };
    return {
      quotaUnits: units,
      costUsd: cost,
      commit: (actual) => {
        settle();
        this.requests += 1;
        // Providers like YouTube charge quota even for failed requests; callers pass actuals.
        this.quotaUnits += actual?.quotaUnits ?? units;
        this.costUsd += actual?.costUsd ?? cost;
      },
      release: () => settle(),
    };
  }

  addRecords(n: number): void {
    this.records += n;
  }

  snapshot(): MeterSnapshot {
    return {
      requests: this.requests,
      quotaUnits: this.quotaUnits,
      costUsd: Math.round(this.costUsd * 1e6) / 1e6,
      records: this.records,
      reservedQuotaUnits: this.reservedUnits,
      reservedCostUsd: this.reservedCost,
      limits: { ...this.limits },
    };
  }
}
