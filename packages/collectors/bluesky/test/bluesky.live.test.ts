/**
 * OPT-IN live smoke test against the REAL Bluesky public AppView.
 * Run: npm run test:live   (never part of `npm test`; bounded to 10 requests)
 */
import { describe, expect, it } from 'vitest';
import { UsageMeter } from '@sss/collector-core';
import { BlueskyAdapter } from '../src/index.ts';

describe('Bluesky live smoke', () => {
  const a = new BlueskyAdapter({ meter: new UsageMeter({ maxRequests: 10 }) });

  it('resolves a public account to its stable DID and reads real counts', async () => {
    const acc = await a.resolveAccount({ input: 'https://bsky.app/profile/bsky.app' });
    expect(acc.externalId).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
    expect(acc.metrics?.followers).toBeGreaterThan(0);
  });

  it('lists recent own posts with metrics and no view count', async () => {
    const page = await a.listPosts({ accountExternalId: 'did:plc:z72i7hdynmk6r22z27h6tvur', limit: 10 });
    for (const p of page.items) {
      expect(p.accountExternalId).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
      expect(p.metrics?.views).toBeNull();
    }
  });

  it('returns a typed NOT_FOUND for a nonexistent handle', async () => {
    await expect(a.resolveAccount({ input: 'this-handle-should-not-exist-zz91.bsky.social' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
