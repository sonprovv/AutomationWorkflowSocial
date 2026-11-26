/** Phase 9 (P9-04): Ad Spy desk-research records are schema-valid and never claim derived spend, revenue or ROAS. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adSourceRecordSchema } from '../src/ad-sources.ts';

const DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'docs/feasibility/ad-sources');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

describe('ad source records (P9-04)', () => {
  it('cover Meta, Google and TikTok', () => {
    expect(files.sort()).toEqual(['google-ads-transparency.json', 'meta-ad-library.json', 'tiktok-commercial-content.json']);
  });

  it.each(files)('%s is schema-valid, unverified by desk research, and spend is never exact', (f) => {
    const r = adSourceRecordSchema.safeParse(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
    expect(r.data.status).not.toBe('VERIFIED');
    expect(r.data.neverInfer).toEqual(['spend', 'revenue', 'ROAS']);
  });

  it('rejects records that would publish derived or exact spend', () => {
    const meta = JSON.parse(readFileSync(join(DIR, 'meta-ad-library.json'), 'utf8'));
    expect(adSourceRecordSchema.safeParse({ ...meta, publishedMetrics: [{ field: 'spend', form: 'exact', scope: 'all ads' }] }).success).toBe(false);
    expect(adSourceRecordSchema.safeParse({ ...meta, publishedMetrics: [] }).success).toBe(false); // spend PARTIAL without a published spend field
    expect(adSourceRecordSchema.safeParse({ ...meta, status: 'VERIFIED' }).success).toBe(false);
  });
});
