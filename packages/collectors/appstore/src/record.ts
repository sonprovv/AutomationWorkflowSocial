import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Feasibility record for an app store (docs/feasibility/app-stores/<store>.json). Kept apart from the social
 * capability records (docs/feasibility/capabilities/) because app stores have different operations and are
 * not social providers in the registry. Same rule: deny-by-default until the Product Owner approves a proposal.
 */
const state = z.enum(['SUPPORTED', 'PARTIAL', 'AUTH_REQUIRED', 'NOT_SUPPORTED', 'BLOCKED', 'UNKNOWN']);
const policy = z.object({
  storeMetadata: z.boolean(),
  historicalSnapshots: z.boolean(),
  mediaProcessing: z.boolean(),
  export: z.boolean(),
  developerWebsiteFetch: z.boolean(),
  retentionDays: z.number().int().positive().nullable(),
});

export const storeRecordSchema = z
  .object({
    store: z.enum(['apple', 'google-play']),
    provider: z.string().min(1),
    status: z.enum(['VERIFIED', 'UNVERIFIED', 'AUTH_REQUIRED', 'BLOCKED', 'NOT_SUPPORTED']),
    checkedAt: z.iso.date(),
    capabilities: z.object({ searchApps: state, getApp: state, lookupByBundleId: state, listDeveloperApps: state, developerWebsite: state, reviews: state }).strict(),
    policy: policy.extend({ policyId: z.string().min(1), notes: z.array(z.string()), sources: z.array(z.object({ url: z.url(), checkedAt: z.iso.date() })).min(1) }),
    policyProposal: policy.extend({ status: z.enum(['PENDING_PRODUCT_OWNER_APPROVAL', 'APPROVED', 'REJECTED']), conditions: z.array(z.string()) }).optional(),
    quota: z.object({ unit: z.string(), perMinute: z.number().nullable(), notes: z.array(z.string()) }),
    credentialsRequired: z.array(z.string()),
    limitations: z.array(z.string()),
    evidence: z.array(z.string()),
  })
  .superRefine((r, ctx) => {
    if (r.status !== 'VERIFIED') {
      const p = r.policy;
      if (p.storeMetadata || p.historicalSnapshots || p.mediaProcessing || p.export || p.developerWebsiteFetch) ctx.addIssue({ code: 'custom', message: `${r.store}: a non-verified store must not allow any data operation` });
    }
    // Deny-by-default for everything that goes beyond showing and keeping the latest listing.
    if (r.policyProposal?.status !== 'APPROVED' && (r.policy.historicalSnapshots || r.policy.mediaProcessing || r.policy.export)) {
      ctx.addIssue({ code: 'custom', message: `${r.store}: snapshots, media and export stay off until the Product Owner approves the proposal` });
    }
  });
export type StoreRecord = z.infer<typeof storeRecordSchema>;

/** Effective policy: the approved proposal, else the deny-by-default policy. */
export function effectiveStorePolicy(r: StoreRecord) {
  const src = r.policyProposal?.status === 'APPROVED' ? r.policyProposal : r.policy;
  return { policyId: r.policyProposal?.status === 'APPROVED' ? `${r.policy.policyId}-approved` : r.policy.policyId, storeMetadata: src.storeMetadata, historicalSnapshots: src.historicalSnapshots, mediaProcessing: src.mediaProcessing, export: src.export, developerWebsiteFetch: src.developerWebsiteFetch, retentionDays: src.retentionDays };
}

export function loadStoreRecord(path: string): StoreRecord {
  return storeRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
