import { z } from 'zod';

/**
 * Ad Spy desk-research records (Phase 9, P9-04): docs/feasibility/ad-sources/*.json. Records only, no adapter.
 * Hard rule: no source may be used to infer spend, revenue or ROAS. Only values the source itself publishes
 * (for example Meta's spend RANGES for political ads) may ever be shown, labelled as the source publishes them.
 */
const state = z.enum(['SUPPORTED', 'PARTIAL', 'AUTH_REQUIRED', 'NOT_SUPPORTED', 'BLOCKED', 'UNKNOWN']);
export const adSourceRecordSchema = z
  .object({
    source: z.enum(['meta-ad-library', 'google-ads-transparency', 'tiktok-commercial-content']),
    status: z.enum(['VERIFIED', 'UNVERIFIED', 'AUTH_REQUIRED', 'BLOCKED', 'LEGAL_RISK']),
    checkedAt: z.iso.date(),
    access: z.object({ official: z.boolean(), path: z.string(), credential: z.string().nullable(), approval: z.string().nullable(), cost: z.string() }).strict(),
    coverage: z.object({ regions: z.array(z.string()), adTypes: z.string(), history: z.string() }).strict(),
    capabilities: z.object({ searchByAdvertiser: state, searchByKeyword: state, creativeText: state, deliveryDates: state, reach: state, spend: state, targeting: state }).strict(),
    publishedMetrics: z.array(z.object({ field: z.string(), form: z.enum(['exact', 'range', 'bucket', 'percentage']), scope: z.string() }).strict()),
    neverInfer: z.tuple([z.literal('spend'), z.literal('revenue'), z.literal('ROAS')]),
    dataUse: z.array(z.string()),
    unverified: z.array(z.string()),
    sources: z.array(z.object({ url: z.url(), checkedAt: z.iso.date(), note: z.string().optional() }).strict()).min(1),
    decisionForProductOwner: z.string().min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    // Spend can only appear when the source itself publishes it; it is never derived.
    if (r.capabilities.spend !== 'NOT_SUPPORTED' && !r.publishedMetrics.some((m) => m.field === 'spend')) ctx.addIssue({ code: 'custom', message: `${r.source}: spend listed but not published by the source` });
    if (r.publishedMetrics.some((m) => m.field === 'spend' && m.form === 'exact')) ctx.addIssue({ code: 'custom', message: `${r.source}: no ad source publishes exact spend; record it as the source does (range)` });
    // Desk research alone never verifies a source: that needs a live PoC.
    if (r.status === 'VERIFIED') ctx.addIssue({ code: 'custom', message: `${r.source}: desk research cannot mark a source VERIFIED` });
  });
export type AdSourceRecord = z.infer<typeof adSourceRecordSchema>;
