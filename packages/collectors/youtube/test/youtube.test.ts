import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageMeter } from '@sss/collector-core';
import { noSleep, startFakeServer, type FakeServer } from '@sss/collector-core/testing';
import { YouTubeAdapter, classifyYouTubeError, normalizeVideo, parseChannelInput } from '../src/index.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/youtube/${name}`, import.meta.url), 'utf8'));

describe('parseChannelInput', () => {
  it.each([
    ['https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', { kind: 'id', value: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }],
    ['https://www.youtube.com/@GoogleDevelopers', { kind: 'handle', value: '@GoogleDevelopers' }],
    ['https://youtube.com/@GoogleDevelopers/videos', { kind: 'handle', value: '@GoogleDevelopers' }],
    ['@MrBeast', { kind: 'handle', value: '@MrBeast' }],
    ['https://www.youtube.com/user/GoogleDevelopers', { kind: 'username', value: 'GoogleDevelopers' }],
    ['https://www.youtube.com/c/GoogleDevelopers', { kind: 'custom', value: 'GoogleDevelopers' }],
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', { kind: 'video', value: 'jNQXAC9IVRw' }],
    ['https://youtu.be/jNQXAC9IVRw', { kind: 'video', value: 'jNQXAC9IVRw' }],
    ['https://www.youtube.com/shorts/jNQXAC9IVRw', { kind: 'video', value: 'jNQXAC9IVRw' }],
    ['UC_x5XG1OV2P6uZZ5FSM9Ttw', { kind: 'id', value: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }],
  ])('%s', (input, expected) => expect(parseChannelInput(input)).toEqual(expected));

  it.each(['', 'https://vimeo.com/123', 'just words', 'https://www.youtube.com/results?search_query=x'])('rejects %j', (input) => {
    expect(() => parseChannelInput(input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('classifyYouTubeError', () => {
  const mk = (status: number, body: unknown) => ({ status, headers: new Headers(), body, text: JSON.stringify(body) });
  it('distinguishes invalid key, missing key, quota, API disabled, rate limit', () => {
    expect(classifyYouTubeError(mk(400, fixture('error-api-key-invalid.json'))).code).toBe('AUTH_REQUIRED');
    expect(classifyYouTubeError(mk(403, fixture('error-no-key.json'))).code).toBe('PERMISSION_DENIED');
    expect(classifyYouTubeError(mk(403, fixture('error-quota-exceeded.json'))).code).toBe('QUOTA_EXCEEDED');
    expect(classifyYouTubeError(mk(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } })).message).toMatch(/not enabled/);
    expect(classifyYouTubeError(mk(400, { error: { details: [{ reason: 'API_KEY_EXPIRED' }] } })).code).toBe('AUTH_EXPIRED');
    expect(classifyYouTubeError(mk(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } })).code).toBe('RATE_LIMITED');
    expect(classifyYouTubeError(mk(403, { error: { errors: [{ reason: 'commentsDisabled' }] } })).code).toBe('PERMISSION_DENIED');
    expect(classifyYouTubeError(mk(404, { error: { errors: [{ reason: 'videoNotFound' }] } })).code).toBe('NOT_FOUND');
    expect(classifyYouTubeError(mk(503, { error: { errors: [{ reason: 'backendError' }] } })).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('normalizeVideo', () => {
  it('keeps hidden likes / disabled comments as null with a reason (not 0)', () => {
    const [hidden, zeros] = fixture('videos-list.json').items;
    const p = normalizeVideo(hidden, 'videos.list', '2026-11-26T00:00:00Z');
    expect(p).toMatchObject({
      externalId: 'AAAAAAAAAA1',
      accountExternalId: 'UCfixturechannel00000001',
      durationSeconds: 45,
      contentType: 'video',
      hashtags: ['livewallpaper', 'depth'],
      thumbnailUrl: 'https://i.ytimg.com/vi/AAAAAAAAAA1/hqdefault.jpg',
      language: 'en',
    });
    expect(p.metrics).toMatchObject({ views: 1000, likes: null, comments: null, shares: null });
    expect(p.metrics!.missing).toMatchObject({ likes: 'HIDDEN_BY_OWNER', comments: 'DISABLED', shares: 'NOT_SUPPORTED' });
    const z = normalizeVideo(zeros, 'videos.list', '2026-11-26T00:00:00Z');
    expect(z.metrics).toMatchObject({ views: 0, likes: 0, comments: 0 });
  });
});

describe('YouTubeAdapter contract (local fake API)', () => {
  let srv: FakeServer;
  afterEach(async () => srv?.close());

  const adapter = (meter = new UsageMeter({ maxQuotaUnits: 1000 }), apiKey: string | null = 'test-key-not-real-0000') =>
    new YouTubeAdapter({ apiKey: apiKey ?? undefined, meter, baseUrl: `${srv.baseUrl}/youtube/v3/`, allowedHosts: ['127.0.0.1'], sleep: noSleep });

  it('reports MISSING credentials without calling the API', async () => {
    srv = await startFakeServer({});
    const a = adapter(undefined, null);
    expect((await a.validateCredentials()).state).toBe('MISSING');
    await expect(a.getProfile('UC_x5XG1OV2P6uZZ5FSM9Ttw')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(srv.requests).toHaveLength(0);
  });

  it('sends the key in a header (never the URL) and maps an invalid key to INVALID', async () => {
    srv = await startFakeServer({ '/youtube/v3/videos': () => ({ status: 400, body: fixture('error-api-key-invalid.json') }) });
    const s = await adapter().validateCredentials();
    expect(s.state).toBe('INVALID');
    expect(srv.requests[0]!.headers['x-goog-api-key']).toBe('test-key-not-real-0000');
    expect(srv.requests[0]!.url.search).not.toContain('test-key');
  });

  it('maps quota exhaustion to QUOTA_EXCEEDED and does not retry', async () => {
    srv = await startFakeServer({ '/youtube/v3/videos': () => ({ status: 403, body: fixture('error-quota-exceeded.json') }) });
    expect((await adapter().validateCredentials()).state).toBe('QUOTA_EXCEEDED');
    expect(srv.requests).toHaveLength(1);
  });

  it('charges search at the upper-bound cost and refuses to exceed the run budget', async () => {
    srv = await startFakeServer({
      '/youtube/v3/search': () => ({ body: { items: [{ id: { kind: 'youtube#video', videoId: 'AAAAAAAAAA1' } }], nextPageToken: 'P2' } }),
      '/youtube/v3/videos': () => ({ body: fixture('videos-list.json') }),
    });
    const meter = new UsageMeter({ maxQuotaUnits: 150 });
    const a = adapter(meter);
    const page = await a.searchPosts({ query: 'live wallpaper', region: 'vn', language: 'vi' });
    expect(page.items.map((p) => p.externalId)).toEqual(['AAAAAAAAAA1']);
    expect(page.usage).toMatchObject({ requests: 2, quotaUnits: 101 });
    expect(page.nextCursor).toBe('P2');
    const sq = srv.requests[0]!.url.searchParams;
    expect(sq.get('regionCode')).toBe('VN');
    expect(sq.get('relevanceLanguage')).toBe('vi');
    await expect(a.searchPosts({ query: 'again' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(srv.requests).toHaveLength(2); // second search never sent
  });

  it('listPosts walks the uploads playlist and reports videos missing from videos.list', async () => {
    srv = await startFakeServer({
      '/youtube/v3/channels': () => ({
        body: { items: [{ id: 'UCfixturechannel00000001', snippet: { title: 'Fixture' }, statistics: { hiddenSubscriberCount: true, videoCount: '2' }, contentDetails: { relatedPlaylists: { uploads: 'UUfixture' } } }] },
      }),
      '/youtube/v3/playlistItems': () => ({
        body: { items: [{ contentDetails: { videoId: 'AAAAAAAAAA1' } }, { contentDetails: { videoId: 'AAAAAAAAAA2' } }, { contentDetails: { videoId: 'GONEGONE001' } }], nextPageToken: 'NEXT' },
      }),
      '/youtube/v3/videos': () => ({ body: fixture('videos-list.json') }),
    });
    const a = adapter();
    const acc = await a.getProfile('UCfixturechannel00000001');
    expect(acc.metrics).toMatchObject({ followers: null, postsCount: 2, missing: { followers: 'HIDDEN_BY_OWNER' } });
    const page = await a.listPosts({ accountExternalId: 'UCfixturechannel00000001', limit: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.warnings.join()).toMatch(/1 upload\(s\) not returned/);
    expect(page.nextCursor).toBe('NEXT');
    expect(srv.requests.find((r) => r.url.pathname.endsWith('playlistItems'))!.url.searchParams.get('playlistId')).toBe('UUfixture');
  });

  it('resolveAccount returns NOT_FOUND (with hint) for unknown legacy custom URLs', async () => {
    srv = await startFakeServer({ '/youtube/v3/channels': () => ({ body: { kind: 'youtube#channelListResponse' } }) });
    await expect(adapter().resolveAccount({ input: 'https://www.youtube.com/c/SomeLegacyName' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/legacy \/c\//),
    });
  });
});
