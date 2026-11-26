import { CollectorError } from '@sss/collector-core';
import type { Db } from '@sss/database';

/**
 * Policy guard (Master Plan §9.2) — Phase 1 scope: read the effective data policy for a provider
 * and answer allow/deny for each data operation. Deny-by-default when no policy exists.
 * Full lifecycle (re-evaluation on change, cleanup, export/backup checks) is Phase 4.
 */
export const OPERATIONS = ['collect', 'storeHistory', 'derivedMetrics', 'mediaProcessing', 'export'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface EffectivePolicy {
  policyId: string;
  providerId: string;
  allowHistoricalSnapshots: boolean;
  allowDerivedMetrics: boolean;
  allowMediaProcessing: boolean;
  allowExport: boolean;
  retentionDays: number | null;
  refreshDays: number | null;
}

export const DENY_ALL = (providerId: string): EffectivePolicy => ({
  policyId: `${providerId}:deny-all`,
  providerId,
  allowHistoricalSnapshots: false,
  allowDerivedMetrics: false,
  allowMediaProcessing: false,
  allowExport: false,
  retentionDays: null,
  refreshDays: null,
});

export async function getEffectivePolicy(db: Db, providerId: string): Promise<EffectivePolicy> {
  const p = await db.dataPolicy.findFirst({ where: { providerId }, orderBy: { version: 'desc' } });
  if (!p) return DENY_ALL(providerId);
  const ops = (p.allowedOperations ?? {}) as Record<string, unknown>;
  return {
    policyId: p.id,
    providerId,
    allowHistoricalSnapshots: ops.allowHistoricalSnapshots === true,
    allowDerivedMetrics: ops.allowDerivedMetrics === true,
    allowMediaProcessing: ops.allowMediaProcessing === true,
    allowExport: ops.allowExport === true,
    retentionDays: p.retentionDays,
    refreshDays: p.refreshDays,
  };
}

export function isAllowed(p: EffectivePolicy, op: Operation): boolean {
  switch (op) {
    case 'collect':
      return true; // collection of current public data is governed by provider enablement (Phase 0 gate)
    case 'storeHistory':
      return p.allowHistoricalSnapshots;
    case 'derivedMetrics':
      return p.allowDerivedMetrics;
    case 'mediaProcessing':
      return p.allowMediaProcessing;
    case 'export':
      return p.allowExport;
  }
}

export function assertAllowed(p: EffectivePolicy, op: Operation): void {
  if (!isAllowed(p, op)) {
    throw new CollectorError('POLICY_BLOCKED', `Operation "${op}" is not allowed by policy ${p.policyId}`);
  }
}
