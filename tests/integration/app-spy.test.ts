/**
 * Phase 9 (P9-03) App Spy through the API: track by App Store link, search, refresh, developer apps, usage caps,
 * and app → developer website → social account links with evidence (never by name). SYNTHETIC store and website data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppleAppStoreClient, type PageFetchResult } from '@sss/collector-appstore';
import { startFakeServer, type FakeServer } from '@sss/collector-core/testing';
import { setAppSpyDepsForTests } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, FIXTURE_HANDLE, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
let apple: FakeServer;
let restore: () => void;
afterEach(async () => {
  restore?.();
  await app?.close();
  await h?.close();
  await apple?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

const listing = (id: number, over: Record<string, unknown> = {}) => ({
  wrapperType: 'software',
  trackId: id,
  trackName: `Synthetic Notes ${id}`,
  bundleId: `com.example.notes${id}`,
  artistId: 900001,
  artistName: 'Example Dev (SYNTHETIC)',
  sellerUrl: 'https://brand.example.com/',
  trackViewUrl: `https://apps.apple.com/us/app/synthetic/id${id}?uo=4`,
  primaryGenreName: 'Productivity',
  price: 0,
  currency: 'USD',
  averageUserRating: 4.6,
  userRatingCount: 321,
  version: '2.0',
  currentVersionReleaseDate: '2026-11-01T00:00:00Z',
  ...over,
});

async function setup(opts: { config?: Record<string, string>; site?: (url: string) => PageFetchResult; gone?: Set<string> } = {}) {
  apple = await startFakeServer({
    '/search': () => ({ body: { resultCount: 2, results: [listing(111111), listing(222222, { sellerUrl: undefined })] } }),
    '/lookup': ({ url }) => {
      if (url.searchParams.get('entity') === 'software') return { body: { resultCount: 3, results: [{ wrapperType: 'artist', artistId: 900001, artistName: 'Example Dev' }, listing(111111), listing(333333)] } };
      const id = url.searchParams.get('id') ?? (url.searchParams.get('bundleId') === 'com.example.notes111111' ? '111111' : '');
      return opts.gone?.has(id) || !id ? { body: { resultCount: 0, results: [] } } : { body: { resultCount: 1, results: [listing(Number(id))] } };
    },
  });
  h = await createHarness({ '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }), '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [] } }) }, opts.config);
  restore = setAppSpyDepsForTests({
    client: (o) => new AppleAppStoreClient({ ...o, baseUrl: apple.baseUrl, allowedHosts: ['127.0.0.1'], minIntervalMs: 0 }),
    fetchPage: async (url) =>
      opts.site?.(url) ?? {
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        redirects: [],
        fetchedAt: new Date().toISOString(),
        html: `<footer><a href="https://bsky.app/profile/${FIXTURE_HANDLE}">Bluesky</a> <a href="https://twitter.com/ExampleNotes">X</a> <a href="https://twitter.com/intent/tweet?text=hi">share</a></footer>`,
      },
  });
  app = await buildServer({ runtime: h.runtime });
  const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Apps', platforms: ['bluesky'] } }));
  return pr.id as string;
}

describe('App Spy API', () => {
  it('tracks by link, searches, refreshes, lists developer apps and links social accounts only through the developer website', async () => {
    const projectId = await setup();
    // A tracked Bluesky account with the same handle as the link on the developer website.
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId, sync: false } });

    expect(json(await app.inject({ method: 'GET', url: '/api/v1/apps/policy' }))).toMatchObject({ status: 'VERIFIED', storeMetadata: true, export: false, historicalSnapshots: false, proposalStatus: 'PENDING_PRODUCT_OWNER_APPROVAL' });

    const tracked = await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { input: 'https://apps.apple.com/us/app/synthetic/id111111', projectId } });
    expect(tracked.statusCode).toBe(201);
    const a = json(tracked);
    expect(a).toMatchObject({ storeAppId: '111111', country: 'us', websiteUrl: 'https://brand.example.com/', storeUrl: 'https://apps.apple.com/us/app/synthetic/id111111', rating: 4.6, projectIds: [projectId], links: [], provenance: { providerId: 'apple-itunes-search', policyId: 'apple-itunes-search-v0' } });
    // Same app by bundle id → same row.
    expect(json(await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { input: 'com.example.notes111111' } })).id).toBe(a.id);

    const search = json(await app.inject({ method: 'GET', url: '/api/v1/apps/search?term=notes&country=US' }));
    expect(search.items.map((x: any) => [x.storeAppId, x.trackedId])).toEqual([['111111', a.id], ['222222', null]]);
    expect(search.items[1].missing).toMatchObject({ websiteUrl: 'NOT_LISTED_BY_DEVELOPER' });
    expect(search.note).toMatch(/fuzzy/);
    expect(JSON.stringify(search)).not.toMatch(/artwork|mzstatic|screenshot/i);

    const dev = json(await app.inject({ method: 'GET', url: `/api/v1/apps/${a.id}/developer-apps` }));
    expect(dev.items.map((x: any) => [x.storeAppId, x.trackedId])).toEqual([['111111', a.id], ['333333', null]]);

    const found = json(await app.inject({ method: 'POST', url: `/api/v1/apps/${a.id}/discover-links` }));
    expect(found).toMatchObject({ found: 2, created: 2, matchedTrackedAccounts: 1, sameSite: true });
    const links = found.app.links;
    const bsky = links.find((l: any) => l.platform === 'bluesky');
    expect(bsky).toMatchObject({ handle: FIXTURE_HANDLE, status: 'PROPOSED', confidence: 'HIGH', method: 'DEVELOPER_WEBSITE', account: { platform: 'bluesky' }, evidence: { websiteUrl: 'https://brand.example.com/', href: `https://bsky.app/profile/${FIXTURE_HANDLE}`, storeUrl: a.storeUrl } });
    expect(links.find((l: any) => l.platform === 'x')).toMatchObject({ handle: 'examplenotes', account: null });

    const decided = json(await app.inject({ method: 'PATCH', url: `/api/v1/app-links/${bsky.id}`, payload: { status: 'CONFIRMED' } }));
    expect(decided.links.find((l: any) => l.id === bsky.id)).toMatchObject({ status: 'CONFIRMED', decidedAt: expect.any(String) });
    // Running discovery again keeps the decision.
    await app.inject({ method: 'POST', url: `/api/v1/apps/${a.id}/discover-links` });
    expect(json(await app.inject({ method: 'GET', url: `/api/v1/apps/${a.id}` })).links.find((l: any) => l.id === bsky.id).status).toBe('CONFIRMED');

    const list = json(await app.inject({ method: 'GET', url: `/api/v1/apps?projectId=${projectId}` }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: a.id, linkCount: 2 });

    // Apple calls are counted in usage_logs.
    const used = await h.db.usageLog.aggregate({ where: { providerId: 'apple-itunes-search' }, _sum: { quantity: true } });
    expect(used._sum.quantity).toBe(4); // lookup, bundle lookup, search, developer
    await app.inject({ method: 'DELETE', url: `/api/v1/apps/${a.id}?projectId=${projectId}` });
    expect(json(await app.inject({ method: 'GET', url: `/api/v1/apps?projectId=${projectId}` })).items).toHaveLength(0);
  });

  it('refuses Google Play and unknown apps, flags apps that disappear, marks cross-site redirects MEDIUM, and enforces the daily cap', async () => {
    const gone = new Set<string>();
    await setup({
      config: { APPLE_SEARCH_DAILY_REQUESTS: '3' },
      gone,
      site: (url) => ({ requestedUrl: url, finalUrl: 'https://other-brand.example.net/', redirects: ['https://other-brand.example.net/'], status: 200, fetchedAt: new Date().toISOString(), html: '<a href="https://www.instagram.com/examplenotes/">ig</a>' }),
    });
    const play = await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { input: 'https://play.google.com/store/apps/details?id=com.example' } });
    expect(play.statusCode).toBe(422);
    expect(json(play).error.code).toBe('NOT_SUPPORTED');
    gone.add('555555');
    expect((await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { input: '555555' } })).statusCode).toBe(404);

    const a = json(await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { input: '111111' } }));
    const found = json(await app.inject({ method: 'POST', url: `/api/v1/apps/${a.id}/discover-links` }));
    expect(found).toMatchObject({ sameSite: false, found: 1 });
    expect(found.app.links[0]).toMatchObject({ platform: 'instagram', confidence: 'MEDIUM', evidence: { finalUrl: 'https://other-brand.example.net/' } });

    gone.add('111111');
    expect(json(await app.inject({ method: 'POST', url: `/api/v1/apps/${a.id}/refresh` })).status).toBe('NOT_FOUND');
    // 3 calls used (unknown id, lookup, refresh): the 4th is refused before any request.
    const capped = await app.inject({ method: 'GET', url: '/api/v1/apps/search?term=notes' });
    expect(capped.statusCode).toBe(429);
    expect(json(capped).error.code).toBe('BUDGET_EXCEEDED');

    // An app without a developer website cannot be linked (no name matching).
    await h.db.app.update({ where: { id: a.id }, data: { websiteUrl: null } });
    const noSite = await app.inject({ method: 'POST', url: `/api/v1/apps/${a.id}/discover-links` });
    expect(noSite.statusCode).toBe(400);
    expect(json(noSite).error.message).toMatch(/names are never matched/);
  });
});
