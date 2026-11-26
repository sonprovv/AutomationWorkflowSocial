/**
 * OPT-IN live smoke test against the REAL YouTube Data API v3.
 * Requires YOUTUBE_API_KEY (in .env or the environment). Spends at most ~10 quota units (no search).
 * Run: npm run test:live
 */
import { describe, expect, it } from 'vitest';
import { UsageMeter, loadDotEnv, secretEnv } from '@sss/collector-core';
import { YouTubeAdapter } from '../src/index.ts';

loadDotEnv();
const key = secretEnv('YOUTUBE_API_KEY');

describe.skipIf(!key)('YouTube live smoke (needs YOUTUBE_API_KEY)', () => {
  const a = new YouTubeAdapter({ apiKey: key, meter: new UsageMeter({ maxQuotaUnits: 10 }) });

  it('validates the key', async () => {
    expect((await a.validateCredentials()).state).toBe('VALID');
  });

  it('resolves a @handle to a stable UC… channel ID and lists uploads', async () => {
    const acc = await a.resolveAccount({ input: '@GoogleDevelopers' });
    expect(acc.externalId).toMatch(/^UC[0-9A-Za-z_-]{22}$/);
    const page = await a.listPosts({ accountExternalId: acc.externalId, limit: 5 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.usage.quotaUnits).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(Boolean(key))('YouTube live smoke (no key)', () => {
  it.skip('skipped: set YOUTUBE_API_KEY to run', () => {});
});
