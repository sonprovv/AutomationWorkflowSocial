/** Phase 9 (P9-03) App Spy collector: Apple client (fake server, SYNTHETIC data), link extraction, SSRF-safe fetch, records. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageMeter } from '@sss/collector-core';
import { startFakeServer, type FakeServer } from '@sss/collector-core/testing';
import {
  AppleAppStoreClient,
  classifySocialUrl,
  effectiveStorePolicy,
  extractSocialLinks,
  fetchPublicPage,
  isPublicAddress,
  normalizeApp,
  parseAppInput,
  resetApplePacingForTests,
  siteOf,
  storeRecordSchema,
} from '../src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const fakeApp = (id: number, over: Record<string, unknown> = {}) => ({
  wrapperType: 'software',
  kind: 'software',
  trackId: id,
  trackName: `Synthetic App ${id}`,
  bundleId: `com.example.app${id}`,
  artistId: 900001,
  artistName: 'Example Dev (SYNTHETIC)',
  sellerName: 'Example Dev Ltd',
  sellerUrl: 'https://dev.example.com',
  artistViewUrl: 'https://apps.apple.com/us/developer/example/id900001?uo=4',
  trackViewUrl: `https://apps.apple.com/us/app/synthetic/id${id}?uo=4`,
  primaryGenreName: 'Productivity',
  genres: ['Productivity'],
  price: 0,
  currency: 'USD',
  averageUserRating: 4.5,
  userRatingCount: 1200,
  version: '1.2.3',
  releaseDate: '2024-01-01T08:00:00Z',
  currentVersionReleaseDate: '2026-11-01T08:00:00Z',
  description: 'synthetic',
  artworkUrl512: 'https://is1-ssl.mzstatic.com/icon.png',
  ...over,
});

let fake: FakeServer | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  resetApplePacingForTests();
});

describe('Apple App Store client', () => {
  it('normalizes listings: canonical store links, website, missing reasons; no artwork kept', () => {
    const a = normalizeApp(fakeApp(123456, { sellerUrl: undefined, averageUserRating: undefined }), 'US');
    expect(a).toMatchObject({ storeAppId: '123456', country: 'us', storeUrl: 'https://apps.apple.com/us/app/synthetic/id123456', developerUrl: 'https://apps.apple.com/us/developer/example/id900001', websiteUrl: null, rating: null });
    expect(a.details.missing).toEqual({ rating: 'NOT_PROVIDED', websiteUrl: 'NOT_LISTED_BY_DEVELOPER' });
    expect(JSON.stringify(a)).not.toMatch(/mzstatic|artwork/);
  });

  it('parses App Store links, ids and bundle ids; refuses Google Play', () => {
    expect(parseAppInput('https://apps.apple.com/vn/app/notion/id1232780281?l=vi')).toEqual({ kind: 'id', id: '1232780281', country: 'vn' });
    expect(parseAppInput('1232780281')).toEqual({ kind: 'id', id: '1232780281' });
    expect(parseAppInput('notion.id')).toEqual({ kind: 'bundle', bundleId: 'notion.id' });
    expect(() => parseAppInput('https://play.google.com/store/apps/details?id=com.x')).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }));
    expect(() => parseAppInput('https://example.com/id123456')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => parseAppInput('Notion')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('searches, looks up, lists developer apps and paces calls process-wide', async () => {
    fake = await startFakeServer({
      '/search': () => ({ body: { resultCount: 2, results: [fakeApp(111111), fakeApp(222222, { sellerUrl: 'javascript:alert(1)' })] } }),
      '/lookup': ({ url }) =>
        url.searchParams.get('entity') === 'software'
          ? { body: { resultCount: 2, results: [{ wrapperType: 'artist', artistId: 900001, artistName: 'Example Dev', artistLinkUrl: 'https://apps.apple.com/us/developer/x/id900001?uo=4' }, fakeApp(111111)] } }
          : { body: { resultCount: 1, results: [fakeApp(Number(url.searchParams.get('id') ?? 333333))] } },
    });
    const waits: number[] = [];
    const c = new AppleAppStoreClient({ meter: new UsageMeter(), baseUrl: fake.baseUrl, allowedHosts: ['127.0.0.1'], minIntervalMs: 1000, sleep: async (ms) => void waits.push(ms) });
    const found = await c.searchApps('notes', { country: 'VN', limit: 500 });
    expect(found.map((a) => a.storeAppId)).toEqual(['111111', '222222']);
    expect(found[1]!.websiteUrl).toBeNull(); // non-http(s) seller URLs are dropped
    const q = fake.requests[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ term: 'notes', media: 'software', entity: 'software', country: 'vn', limit: '200' });
    expect((await c.lookupApps(['444444']))[0]!.storeAppId).toBe('444444');
    const dev = await c.developerApps('900001');
    expect(dev.developer).toEqual({ developerId: '900001', name: 'Example Dev', url: 'https://apps.apple.com/us/developer/x/id900001' });
    expect(dev.apps).toHaveLength(1);
    expect(waits.length).toBeGreaterThanOrEqual(2); // calls 2 and 3 waited for their slot
    await expect(c.lookupApps(['abc'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(c.searchApps('x', { country: 'usa' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('classifies 403/429 as RATE_LIMITED and a changed shape as SCHEMA_CHANGED', async () => {
    fake = await startFakeServer({ '/search': () => ({ status: 403, raw: 'Forbidden' }), '/lookup': () => ({ body: { results: 'nope' } }) });
    const c = new AppleAppStoreClient({ meter: new UsageMeter(), baseUrl: fake.baseUrl, allowedHosts: ['127.0.0.1'], minIntervalMs: 0 });
    await expect(c.searchApps('x')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(c.lookupApps(['123456'])).rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });
});

describe('social links on developer websites', () => {
  it('keeps profiles only (no share buttons, posts, hashtags or intents)', () => {
    expect(classifySocialUrl('https://bsky.app/profile/brand.example.com')).toMatchObject({ platform: 'bluesky', handle: 'brand.example.com' });
    expect(classifySocialUrl('https://www.youtube.com/@BrandTV')).toMatchObject({ platform: 'youtube', handle: 'brandtv' });
    expect(classifySocialUrl('https://youtube.com/channel/UCybCzee6J3ewoXqMuE78JVQ')).toMatchObject({ handle: 'UCybCzee6J3ewoXqMuE78JVQ' });
    expect(classifySocialUrl('https://twitter.com/BrandHQ?ref=footer')).toMatchObject({ platform: 'x', handle: 'brandhq', profileUrl: 'https://x.com/brandhq' });
    expect(classifySocialUrl('https://www.linkedin.com/company/brand-inc/')).toMatchObject({ platform: 'linkedin', handle: 'company:brand-inc' });
    expect(classifySocialUrl('https://www.reddit.com/r/BrandApp')).toMatchObject({ platform: 'reddit', handle: 'r:brandapp' });
    for (const u of ['https://twitter.com/intent/tweet?text=x', 'https://www.facebook.com/sharer/sharer.php?u=x', 'https://www.instagram.com/p/Cx123/', 'https://www.tiktok.com/tag/notes', 'https://www.youtube.com/watch?v=abc', 'https://example.com/brand', 'mailto:hi@brand.com']) {
      expect(classifySocialUrl(u), u).toBeNull();
    }
  });

  it('extracts distinct links from anchors only, resolving relative hrefs', () => {
    const html = `<html><body>
      <a class="x" href="https://x.com/brandhq">X</a><a href='https://twitter.com/BrandHQ'>again</a>
      <a href=https://www.instagram.com/brand.app/>IG</a>
      <a href="/about">about</a>
      <script>var u = "https://www.tiktok.com/@notalink"</script>
      <p>https://www.facebook.com/textonly</p>
      <a href="https://bsky.app/profile/brand.example.com?x=1&amp;y=2">Bluesky</a>
    </body></html>`;
    const links = extractSocialLinks(html, 'https://brand.example.com/');
    expect(links.map((l) => `${l.platform}:${l.handle}`)).toEqual(['x:brandhq', 'instagram:brand.app', 'bluesky:brand.example.com']);
  });

  it('compares sites by registrable domain', () => {
    expect(siteOf('www.goodnotes.com')).toBe('goodnotes.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('gingerlabs.com')).not.toBe(siteOf('notability.com'));
  });
});

describe('SSRF-safe page fetch', () => {
  type Reply = { status?: number; headers?: Record<string, string>; body?: string };
  async function site(handler: (path: string) => Reply) {
    const s = createServer((req, res) => {
      const r = handler(req.url ?? '/');
      res.writeHead(r.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...r.headers });
      res.end(r.body ?? '');
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['17.253.144.10', '8.8.8.8', '2606:4700::6810:84e5']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses loopback, private DNS answers, odd ports and credentials', async () => {
    const base = await site(() => ({ body: '<a href="https://x.com/a">x</a>' }));
    await expect(fetchPublicPage(base)).rejects.toMatchObject({ code: 'POLICY_BLOCKED', message: expect.stringMatching(/port/) });
    await expect(fetchPublicPage(base, { anyPortForTests: true })).rejects.toMatchObject({ code: 'POLICY_BLOCKED', message: expect.stringMatching(/not public/) });
    const localhostDns = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    await expect(fetchPublicPage(base.replace('127.0.0.1', 'rebind.example'), { anyPortForTests: true, lookup: localhostDns })).rejects.toMatchObject({ code: 'POLICY_BLOCKED', message: expect.stringMatching(/non-public/) });
    await expect(fetchPublicPage('http://internal.example/')).rejects.toBeDefined();
    const privateDns = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as never;
    await expect(fetchPublicPage('https://looks-public.example/', { lookup: privateDns })).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(fetchPublicPage('https://user:pw@example.com/')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(fetchPublicPage('ftp://example.com/')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('follows a few redirects, caps size and requires HTML (loopback allowed only in this test)', async () => {
    const base = await site((p): Reply =>
      p === '/start' ? { status: 301, headers: { location: '/home' } } : p === '/home' ? { body: `<a href="https://x.com/brandhq">x</a>${'.'.repeat(5000)}` } : p === '/json' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : p === '/loop' ? { status: 302, headers: { location: '/loop' } } : { status: 404 },
    );
    const any = { isAllowedAddress: () => true, anyPortForTests: true };
    const page = await fetchPublicPage(`${base}/start`, { ...any, maxBytes: 1000 });
    expect(page).toMatchObject({ finalUrl: `${base}/home`, redirects: [`${base}/home`], status: 200 });
    expect(page.html.length).toBe(1000);
    expect(extractSocialLinks(page.html, page.finalUrl)).toHaveLength(1);
    await expect(fetchPublicPage(`${base}/json`, any)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(fetchPublicPage(`${base}/loop`, any)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(fetchPublicPage(`${base}/missing`, any)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('store feasibility records', () => {
  it('are schema-valid and deny-by-default until approved', () => {
    const apple = storeRecordSchema.parse(JSON.parse(readFileSync(join(ROOT, 'docs/feasibility/app-stores/apple.json'), 'utf8')));
    const play = storeRecordSchema.parse(JSON.parse(readFileSync(join(ROOT, 'docs/feasibility/app-stores/google-play.json'), 'utf8')));
    expect(apple.status).toBe('VERIFIED');
    expect(play.status).toBe('BLOCKED');
    expect(effectiveStorePolicy(apple)).toMatchObject({ storeMetadata: true, historicalSnapshots: false, export: false, mediaProcessing: false });
    expect(storeRecordSchema.safeParse({ ...play, policy: { ...play.policy, storeMetadata: true } }).success).toBe(false);
    expect(storeRecordSchema.safeParse({ ...apple, policy: { ...apple.policy, export: true } }).success).toBe(false);
  });
});
