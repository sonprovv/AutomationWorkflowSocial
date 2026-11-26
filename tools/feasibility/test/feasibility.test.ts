import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORMS, UsageMeter, capabilityRecordSchema } from '@sss/collector-core';
import { BlueskyAdapter } from '@sss/collector-bluesky';
import { YouTubeAdapter } from '@sss/collector-youtube';
import { completeness } from '../src/completeness.ts';
import { latencyStats, percentile } from '../src/stats.ts';
import { summarize } from '../src/summary.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CAP_DIR = join(ROOT, 'docs/feasibility/capabilities');

describe('capability records (Phase 0 deliverable)', () => {
  const files = readdirSync(CAP_DIR).filter((f) => f.endsWith('.json'));

  it('exist for every platform in the Master Plan matrix', () => {
    expect(files.map((f) => f.replace('.json', '')).sort()).toEqual([...PLATFORMS].sort());
  });

  it.each(files)('%s is schema-valid and deny-by-default unless verified', (f) => {
    const r = capabilityRecordSchema.safeParse(JSON.parse(readFileSync(join(CAP_DIR, f), 'utf8')));
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
  });

  it('effective policies stay deny-by-default until the Product Owner approves a proposal', () => {
    for (const f of files) {
      const r = capabilityRecordSchema.parse(JSON.parse(readFileSync(join(CAP_DIR, f), 'utf8')));
      if (r.policyProposal?.status !== 'APPROVED') {
        expect(r.policy, f).toMatchObject({ allowHistoricalSnapshots: false, allowDerivedMetrics: false, allowMediaProcessing: false, allowExport: false });
      }
    }
  });

  it('adapter getCapabilities() matches the documented record (no drift)', async () => {
    const bsky = capabilityRecordSchema.parse(JSON.parse(readFileSync(join(CAP_DIR, 'bluesky.json'), 'utf8')));
    expect(await new BlueskyAdapter({ meter: new UsageMeter() }).getCapabilities()).toEqual(bsky.capabilities);
    const yt = capabilityRecordSchema.parse(JSON.parse(readFileSync(join(CAP_DIR, 'youtube.json'), 'utf8')));
    // Documented status reflects "no key configured yet".
    expect(await new YouTubeAdapter({ apiKey: undefined, meter: new UsageMeter() }).getCapabilities()).toEqual(yt.capabilities);
  });
});

describe('stats & completeness', () => {
  it('percentile / latency stats count only 2xx as success and tally error codes', () => {
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
    expect(percentile([], 95)).toBeNull();
    const s = latencyStats([
      { ts: '', providerId: 'p', method: 'GET', url: 'https://a.test/x', status: 200, latencyMs: 10, attempt: 1, quotaUnits: 0 },
      { ts: '', providerId: 'p', method: 'GET', url: 'https://a.test/x', status: 403, latencyMs: 30, attempt: 1, quotaUnits: 0, errorCode: 'PERMISSION_DENIED' },
      { ts: '', providerId: 'p', method: 'GET', url: 'https://a.test/y', status: 200, latencyMs: 20, attempt: 2, quotaUnits: 0 },
    ]);
    expect(s).toMatchObject({ total: 3, success2xx: 2, errors: { PERMISSION_DENIED: 1 }, retries: 1 });
    expect(s.byEndpoint['a.test/x']!.n).toBe(2);
  });

  it('completeness measures presence, and treats 0 as present', () => {
    const prov = { providerId: 'f', collectedAt: '', policyId: 'test-only', schemaVersion: 'f', source: 'fixture' };
    const metrics = { postExternalId: 'p', views: 0, likes: null, comments: 5, shares: null, saves: null, extra: {}, missing: {}, collectedAt: '' };
    const post = { platform: 'bluesky' as const, externalId: 'p', accountExternalId: 'a', url: 'u', contentType: 'text' as const, title: null, caption: 'c', hashtags: [], language: null, thumbnailUrl: null, durationSeconds: null, publishedAt: 'x', metrics, provenance: prov };
    const c = completeness([], [post, post]) as { posts: Record<string, unknown> };
    expect(c.posts).toMatchObject({ n: 1, views: 1, likes: 0, comments: 1, caption: 1, title: 0 });
  });

  it('summary flags fewer than 3 runs and detects unstable IDs', () => {
    const run = (startedAt: string, id: string) => ({
      runId: startedAt, label: null, platform: 'bluesky', status: 'COMPLETED', startedAt, endedAt: startedAt, credentialsConfigured: false,
      usage: { requests: 1, quotaUnits: 0, costUsd: 0 }, summary: { pass: 1, fail: 0, skip: 0, tests: 1 },
      tests: [{ id: 'TC03.1', name: 'resolveAccount x', status: 'PASS' }],
      requestLog: [{ latencyMs: 10, status: 200 }],
      idsObserved: { resolved: { '@x': id }, postsByAccount: {} },
    });
    const md = summarize([run('2026-11-26T01:00:00Z', 'did:a'), run('2026-11-26T03:00:00Z', 'did:b')]);
    expect(md).toMatch(/Only 2 run\(s\)/);
    expect(md).toMatch(/⚠ @x resolved to different IDs/);
    expect(md).toMatch(/Time span covered: 2\.00 h/);
  });
});
