import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityRecordSchema, type CapabilityRecordFile } from '@sss/collector-core';
import type { PrismaClient } from './generated/prisma/client.ts';

/** Load and validate the Phase 0 capability records (docs/feasibility/capabilities/*.json). */
export function loadCapabilityRecords(dir: string): CapabilityRecordFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => capabilityRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/**
 * Upsert providers + data_policies from capability records.
 * - Effective policy = record.policy (deny-by-default), or record.policyProposal only when APPROVED.
 * - A provider is enabled only if it has an implemented adapter AND its record is VERIFIED,
 *   or it is explicitly listed in `enableUnverified` (operator override, logged by the caller).
 */
export async function seedProviders(
  db: PrismaClient,
  opts: { capabilitiesDir: string; implemented: string[]; enableUnverified?: string[]; credentialRefs?: Record<string, string> },
): Promise<{ providerId: string; enabled: boolean; status: string }[]> {
  const out: { providerId: string; enabled: boolean; status: string }[] = [];
  for (const r of loadCapabilityRecords(opts.capabilitiesDir)) {
    const approved = r.policyProposal?.status === 'APPROVED';
    const p = approved ? r.policyProposal! : r.policy;
    const enabled =
      opts.implemented.includes(r.provider) && (r.status === 'VERIFIED' || (opts.enableUnverified ?? []).includes(r.platform));
    await db.provider.upsert({
      where: { id: r.provider },
      create: {
        id: r.provider,
        platform: r.platform,
        status: r.status,
        enabled,
        capabilities: r.capabilities,
        credentialRef: opts.credentialRefs?.[r.platform] ?? null,
      },
      update: { platform: r.platform, status: r.status, enabled, capabilities: r.capabilities, credentialRef: opts.credentialRefs?.[r.platform] ?? null },
    });
    const policy = {
      providerId: r.provider,
      allowedOperations: {
        allowHistoricalSnapshots: p.allowHistoricalSnapshots,
        allowDerivedMetrics: p.allowDerivedMetrics,
        allowMediaProcessing: p.allowMediaProcessing,
        allowExport: p.allowExport,
      },
      retentionDays: p.retentionDays,
      refreshDays: p.refreshDays,
      notes: approved ? (r.policyProposal?.conditions ?? []) : r.policy.notes,
      sources: r.policy.sources,
      verifiedAt: new Date(`${r.checkedAt}T00:00:00Z`),
    };
    await db.dataPolicy.upsert({ where: { id: r.policy.policyId }, create: { id: r.policy.policyId, ...policy }, update: policy });
    out.push({ providerId: r.provider, enabled, status: r.status });
  }
  return out;
}
