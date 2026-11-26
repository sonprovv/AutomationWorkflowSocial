import { z } from 'zod';
import { CAPABILITY_KEYS, PLATFORMS } from './types.ts';

const state = z.enum(['SUPPORTED', 'PARTIAL', 'AUTH_REQUIRED', 'NOT_SUPPORTED', 'BLOCKED', 'UNKNOWN']);
const source = z.object({ url: z.url(), checkedAt: z.iso.date() });

/** Schema for docs/feasibility/capabilities/<platform>.json (the Phase 0 deliverable, consumed by the Phase 1 provider registry). */
export const capabilityRecordSchema = z
  .object({
    platform: z.enum(PLATFORMS),
    provider: z.string().min(1),
    status: z.enum(['VERIFIED', 'UNVERIFIED', 'AUTH_REQUIRED', 'BLOCKED', 'NOT_SUPPORTED']),
    checkedAt: z.iso.date(),
    capabilities: z.object(Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, state])) as Record<(typeof CAPABILITY_KEYS)[number], typeof state>).strict(),
    policy: z.object({
      policyId: z.string().min(1),
      allowHistoricalSnapshots: z.boolean(),
      allowDerivedMetrics: z.boolean(),
      allowMediaProcessing: z.boolean(),
      allowExport: z.boolean(),
      retentionDays: z.number().int().positive().nullable(),
      refreshDays: z.number().int().positive().nullable(),
      notes: z.array(z.string()),
      sources: z.array(source).min(1),
    }),
    policyProposal: z
      .object({
        status: z.enum(['PENDING_PRODUCT_OWNER_APPROVAL', 'APPROVED', 'REJECTED']),
        allowHistoricalSnapshots: z.boolean(),
        allowDerivedMetrics: z.boolean(),
        allowMediaProcessing: z.boolean(),
        allowExport: z.boolean(),
        retentionDays: z.number().int().positive().nullable(),
        refreshDays: z.number().int().positive().nullable(),
        conditions: z.array(z.string()),
      })
      .optional(),
    alternatives: z.array(z.object({ provider: z.string(), status: z.string(), price: z.string().optional(), note: z.string() })).optional(),
    quota: z.object({ unit: z.string(), dailyLimit: z.number().nullable(), notes: z.array(z.string()) }),
    credentialsRequired: z.array(z.string()),
    credentialsOptional: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .superRefine((r, ctx) => {
    // A provider may only be VERIFIED if at least one capability was actually verified.
    if (r.status === 'VERIFIED' && !Object.values(r.capabilities).some((s) => s === 'SUPPORTED' || s === 'PARTIAL')) {
      ctx.addIssue({ code: 'custom', message: 'VERIFIED provider must have at least one SUPPORTED/PARTIAL capability' });
    }
    // Deny-by-default: an unverified/blocked provider must not grant any data operation.
    if (r.status !== 'VERIFIED') {
      const p = r.policy;
      if (p.allowHistoricalSnapshots || p.allowDerivedMetrics || p.allowMediaProcessing || p.allowExport) {
        ctx.addIssue({ code: 'custom', message: `${r.platform}: non-verified provider must keep policy deny-by-default` });
      }
    }
  });

export type CapabilityRecordFile = z.infer<typeof capabilityRecordSchema>;
