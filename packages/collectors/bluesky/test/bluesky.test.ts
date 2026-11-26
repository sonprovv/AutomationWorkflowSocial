import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageMeter } from '@sss/collector-core';
import { noSleep, startFakeServer, type FakeServer } from '@sss/collector-core/testing';
import { BlueskyAdapter, classifyBlueskyError, parseActorInput } from '../src/index.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/bluesky/${name}`, import.meta.url), 'utf8'));

describe('parseActorInput', () => {
  it.each([
    ['https://bsky.app/profile/bsky.app', { kind: 'handle', value: 'bsky.app' }],
    ['@Jay.Bsky.Team', { kind: 'handle', value: 'jay.bsky.team' }],
    ['did:plc:z72i7hdynmk6r22z27h6tvur', { kind: 'did', value: 'did:plc:z72i7hdynmk6r22z27h6tvur' }],
    ['https://bsky.app/profile/did:plc:abc/post/3k2', { kind: 'did', value: 'did:plc:abc', postRkey: '3k2' }],
  ])('%s', (input, expected) => {
    expect(parseActorInput(input)).toEqual(expected);
  });
  it.each(['', 'nodot', 'https://evil.test/profile/x.com', 'https://bsky.app/search?q=x'])('rejects %j', (input) => {
    expect(() => parseActorInput(input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('classifyBlueskyError', () => {
  const mk = (status: number, body: unknown) => ({ status, headers: new Headers(), body, text: JSON.stringify(body) ?? '' });
  it('maps XRPC errors', () => {
    expect(classifyBlueskyError(mk(400, { error: 'InvalidRequest', message: 'Profile not found' })).code).toBe('NOT_FOUND');
    expect(classifyBlueskyError(mk(400, { error: 'NotFound', message: 'Post not found: at://x' })).code).toBe('NOT_FOUND');
    expect(classifyBlueskyError(mk(400, { error: 'AccountTakedown', message: 'x' })).code).toBe('PRIVATE_OR_REMOVED');
    expect(classifyBlueskyError(mk(400, { error: 'ExpiredToken', message: 'x' })).code).toBe('AUTH_EXPIRED');
    expect(classifyBlueskyError(mk(401, { error: 'AuthenticationRequired', message: 'x' })).code).toBe('AUTH_REQUIRED');
    expect(classifyBlueskyError(mk(429, { error: 'RateLimitExceeded', message: 'x' })).code).toBe('RATE_LIMITED');
    expect(classifyBlueskyError(mk(403, undefined)).code).toBe('PERMISSION_DENIED');
  });
});

describe('BlueskyAdapter contract (local fake AppView)', () => {
  let srv: FakeServer;
  afterEach(async () => srv?.close());

  function adapter(extra: Partial<ConstructorParameters<typeof BlueskyAdapter>[0]> = {}) {
    return new BlueskyAdapter({
      meter: new UsageMeter({ maxRequests: 50 }),
      baseUrls: { publicAppView: srv.baseUrl, appView: srv.baseUrl, entryway: srv.baseUrl },
      allowedHosts: ['127.0.0.1'],
      sleep: noSleep,
      ...extra,
    });
  }

  it('listPosts skips reposts and keeps missing counts as null (never 0)', async () => {
    srv = await startFakeServer({ '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: fixture('author-feed.json') }) });
    const page = await adapter().listPosts({ accountExternalId: 'did:plc:fixtureauthor000000000001', limit: 10 });
    expect(page.items.map((p) => p.externalId)).toEqual([
      'at://did:plc:fixtureauthor000000000001/app.bsky.feed.post/3fixturepost1',
      'at://did:plc:fixtureauthor000000000001/app.bsky.feed.post/3fixturepost3',
    ]);
    expect(page.warnings.join()).toMatch(/Skipped 1 repost/);
    expect(page.nextCursor).toBe('fixture-cursor-1');
    const [video, textOnly] = page.items;
    expect(video).toMatchObject({
      contentType: 'video',
      hashtags: ['3dwallpaper'],
      language: 'en',
      url: 'https://bsky.app/profile/did:plc:fixtureauthor000000000001/post/3fixturepost1',
      thumbnailUrl: 'https://video.bsky.app/fixture/thumb.jpg',
    });
    expect(video!.metrics).toMatchObject({ likes: 10, shares: 2, comments: 0, views: null, extra: { quotes: 1 } });
    expect(video!.metrics!.missing.views).toBe('NOT_SUPPORTED');
    expect(textOnly!.metrics).toMatchObject({ likes: null, comments: null, shares: null, saves: null });
    expect(video!.provenance).toMatchObject({ providerId: 'bluesky-appview', source: 'app.bsky.feed.getAuthorFeed' });
    // Cursor / filter actually sent:
    expect(srv.requests[0]!.url.searchParams.get('filter')).toBe('posts_no_replies');
  });

  it('getPostDetail throws NOT_FOUND (not an empty result) when getPosts omits the post', async () => {
    srv = await startFakeServer({ '/xrpc/app.bsky.feed.getPosts': () => ({ body: { posts: [] } }) });
    await expect(adapter().getPostDetail('at://did:plc:abc/app.bsky.feed.post/3zzz')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('raises SCHEMA_CHANGED when a required field disappears', async () => {
    srv = await startFakeServer({
      '/xrpc/app.bsky.actor.getProfile': () => ({ body: { handle: 'x.example.com' /* did missing */ } }),
    });
    await expect(adapter().getProfile('x.example.com')).rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });

  it('searchPosts without credentials warns that the path is undocumented', async () => {
    srv = await startFakeServer({ '/xrpc/app.bsky.feed.searchPosts': () => ({ body: { posts: [], cursor: undefined } }) });
    const page = await adapter().searchPosts({ query: 'live wallpaper', language: 'en', region: 'VN' });
    expect(page.items).toEqual([]);
    expect(page.warnings.join(' ')).toMatch(/undocumented/);
    expect(page.warnings.join(' ')).toMatch(/region ignored/);
    expect(srv.requests[0]!.url.searchParams.get('lang')).toBe('en');
    expect(srv.requests[0]!.headers['authorization']).toBeUndefined();
  });

  it('searchPosts with an App Password uses createSession + atproto-proxy and never logs the token', async () => {
    const logs: string[] = [];
    srv = await startFakeServer({
      '/xrpc/com.atproto.server.createSession': () => ({ body: { did: 'did:plc:me', handle: 'me.example.com', accessJwt: 'jwt-secret-token-value' } }),
      '/xrpc/app.bsky.feed.searchPosts': () => ({ body: { posts: [] } }),
    });
    const a = adapter({ identifier: 'me.example.com', appPassword: 'aaaa-bbbb-cccc-dddd', onLog: (e) => logs.push(JSON.stringify(e)) });
    expect(await a.getCapabilities()).toMatchObject({ searchPosts: 'SUPPORTED' });
    await a.searchPosts({ query: 'x' });
    const search = srv.requests.find((r) => r.url.pathname.endsWith('searchPosts'))!;
    expect(search.headers['authorization']).toBe('Bearer jwt-secret-token-value');
    expect(search.headers['atproto-proxy']).toBe('did:web:api.bsky.app#bsky_appview');
    expect(logs.join()).not.toContain('jwt-secret-token-value');
    expect(logs.join()).not.toContain('aaaa-bbbb-cccc-dddd');
  });

  it('validateCredentials reports INVALID for a wrong App Password', async () => {
    srv = await startFakeServer({
      '/xrpc/com.atproto.server.createSession': () => ({
        status: 401,
        body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
      }),
    });
    const s = await adapter({ identifier: 'me.example.com', appPassword: 'wrong-pass-0000' }).validateCredentials();
    expect(s.state).toBe('INVALID');
  });

  it('validateCredentials reports NOT_REQUIRED without credentials (public reads)', async () => {
    srv = await startFakeServer({});
    expect((await adapter().validateCredentials()).state).toBe('NOT_REQUIRED');
  });

  it('unauthenticated search pagination 403 becomes an actionable typed error (observed live 2026-11-26)', async () => {
    srv = await startFakeServer({
      '/xrpc/app.bsky.feed.searchPosts': ({ url }) =>
        url.searchParams.get('cursor')
          ? { status: 403, raw: '<html><body><h1>403 Forbidden</h1>Request forbidden by administrative rules.</body></html>', headers: { 'content-type': 'text/html' } }
          : { body: { posts: [], cursor: 'c1' } },
    });
    const a = adapter();
    const p1 = await a.searchPosts({ query: 'x' });
    expect(p1.nextCursor).toBe('c1');
    await expect(a.searchPosts({ query: 'x', cursor: 'c1' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      providerReason: 'UNAUTH_SEARCH_PAGINATION_BLOCKED',
      message: expect.stringMatching(/BLUESKY_APP_PASSWORD/),
    });
  });
});
