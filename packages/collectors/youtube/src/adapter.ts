import {
  CollectorError,
  HttpClient,
  defaultClassify,
  listInputSchema,
  parseResponse,
  parseRetryAfter,
  searchInputSchema,
  validateInput,
  type Account,
  type Capabilities,
  type Comment,
  type CredentialState,
  type CredentialStatus,
  type HealthStatus,
  type ListCommentsInput,
  type ListPostsInput,
  type Page,
  type PlatformAdapter,
  type Post,
  type PostMetrics,
  type RawErrorResponse,
  type RequestLogEntry,
  type ResolveAccountInput,
  type SearchInput,
  type UsageMeter,
} from '@sss/collector-core';
import type { z } from 'zod';
import { PROVIDER_ID, normalizeChannel, normalizeVideo, normalizeVideoMetrics, parseChannelInput, provenance } from './normalize.ts';
import {
  channelListResponse,
  commentThreadsResponse,
  playlistItemsResponse,
  searchListResponse,
  videoListResponse,
} from './schemas.ts';

export const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/';

/**
 * Quota unit costs charged to OUR run budget.
 * search.list: docs reviewed 2026-11-26 describe a separate bucket (100 calls/day, 1 unit each), while the
 * historical cost was 100 units. Until verified against a live key we reserve the UPPER BOUND (100).
 */
export interface YouTubeQuotaCosts {
  search: number;
  list: number;
}
export const DEFAULT_QUOTA_COSTS: YouTubeQuotaCosts = { search: 100, list: 1 };

export interface YouTubeAdapterOptions {
  apiKey: string | undefined;
  meter: UsageMeter;
  quotaCosts?: Partial<YouTubeQuotaCosts>;
  timeoutMs?: number;
  onLog?: (e: RequestLogEntry) => void;
  baseUrl?: string;
  allowedHosts?: string[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type GError = { error?: { code?: number; message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };

/** Extract both legacy `errors[].reason` and google.rpc.ErrorInfo `details[].reason`. */
export function youtubeReasons(body: unknown): string[] {
  const e = (body as GError)?.error;
  const out: string[] = [];
  for (const d of e?.details ?? []) if (d.reason) out.push(d.reason);
  for (const d of e?.errors ?? []) if (d.reason) out.push(d.reason);
  return out;
}

export function classifyYouTubeError(res: RawErrorResponse): CollectorError {
  const reasons = youtubeReasons(res.body);
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  const msg = (res.body as GError)?.error?.message ?? res.text.slice(0, 200);
  const opts = { httpStatus: res.status, providerReason: reasons.join(',') || undefined, retryAfterMs: parseRetryAfter(res.headers) };
  if (has('API_KEY_INVALID', 'keyInvalid')) return new CollectorError('AUTH_REQUIRED', `Invalid API key: ${msg}`, opts);
  if (has('API_KEY_EXPIRED', 'keyExpired')) return new CollectorError('AUTH_EXPIRED', msg, opts);
  if (has('quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED')) {
    return new CollectorError('QUOTA_EXCEEDED', `${msg} (YouTube daily quota resets at midnight Pacific Time)`, opts);
  }
  if (has('rateLimitExceeded', 'userRateLimitExceeded', 'limitExceeded')) return new CollectorError('RATE_LIMITED', msg, opts);
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return new CollectorError('PERMISSION_DENIED', `YouTube Data API v3 not enabled for this key's project: ${msg}`, opts);
  }
  if (
    has('API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED', 'ipRefererBlocked')
  ) {
    return new CollectorError('PERMISSION_DENIED', `API key restriction blocks this request: ${msg}`, opts);
  }
  if (has('commentsDisabled')) return new CollectorError('PERMISSION_DENIED', 'Comments are disabled for this video', opts);
  if (has('videoNotFound', 'channelNotFound', 'playlistNotFound', 'commentThreadNotFound')) {
    return new CollectorError('NOT_FOUND', msg, opts);
  }
  if (has('ACCESS_DENIED', 'forbidden')) return new CollectorError('PERMISSION_DENIED', msg, opts);
  const base = defaultClassify(res);
  return new CollectorError(base.code, msg, opts);
}

const MAX_PAGE = 50;

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;
  readonly providerId = PROVIDER_ID;
  private readonly http: HttpClient;
  private readonly costs: YouTubeQuotaCosts;
  private readonly uploadsPlaylist = new Map<string, string>();
  /** Number of search.list calls this instance made (tracked separately: separate quota bucket). */
  searchCalls = 0;

  constructor(private readonly opts: YouTubeAdapterOptions) {
    this.costs = { ...DEFAULT_QUOTA_COSTS, ...opts.quotaCosts };
    const baseUrl = opts.baseUrl ?? YOUTUBE_API;
    this.http = new HttpClient({
      providerId: PROVIDER_ID,
      baseUrl,
      meter: opts.meter,
      allowedHosts: opts.allowedHosts ?? [new URL(baseUrl).hostname],
      // Key goes in a header, never in the URL, so it cannot leak through logged URLs.
      headers: opts.apiKey ? { 'x-goog-api-key': opts.apiKey } : {},
      timeoutMs: opts.timeoutMs ?? 15_000,
      classifyError: classifyYouTubeError,
      onLog: opts.onLog,
      sleep: opts.sleep,
    });
  }

  private requireKey(): void {
    if (!this.opts.apiKey) throw new CollectorError('AUTH_REQUIRED', 'YOUTUBE_API_KEY is not configured');
  }

  private async call<S extends z.ZodType>(
    resource: string,
    query: Record<string, string | number | undefined>,
    schema: S,
    units: number,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    this.requireKey();
    const res = await this.http.request({ path: resource, query, quotaUnits: units, signal });
    return parseResponse(schema, res.data, `youtube.${resource}`);
  }

  async getCapabilities(): Promise<Capabilities> {
    const auth = this.opts.apiKey ? 'SUPPORTED' : 'AUTH_REQUIRED';
    return {
      resolveAccount: auth,
      searchAccounts: auth,
      searchPosts: auth,
      getProfile: auth,
      listPosts: auth,
      getPostDetail: auth,
      getPostMetrics: auth,
      listComments: this.opts.apiKey ? 'PARTIAL' : 'AUTH_REQUIRED',
    };
  }

  async validateCredentials(): Promise<CredentialStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.opts.apiKey) return { state: 'MISSING', message: 'YOUTUBE_API_KEY is not set', checkedAt };
    try {
      // Cheapest authenticated call: 1 unit. Uses a long-lived public video ID only to exercise the key.
      await this.call('videos', { part: 'id', id: 'jNQXAC9IVRw' }, videoListResponse, this.costs.list);
      return { state: 'VALID', message: 'videos.list (1 unit) succeeded', checkedAt };
    } catch (e) {
      const ce = e as CollectorError;
      const map: Partial<Record<CollectorError['code'], CredentialState>> = {
        AUTH_REQUIRED: 'INVALID',
        AUTH_EXPIRED: 'EXPIRED',
        QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
        PERMISSION_DENIED: /not enabled/.test(ce.message) ? 'API_DISABLED' : 'INSUFFICIENT_SCOPE',
      };
      return { state: map[ce.code] ?? 'UNKNOWN', message: `${ce.code} [${ce.providerReason ?? '-'}]: ${ce.message}`, checkedAt };
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    const c = await this.validateCredentials();
    const ok = c.state === 'VALID';
    return { healthy: ok, latencyMs: ok ? Math.round(performance.now() - started) : null, message: `${c.state}: ${c.message}`, checkedAt };
  }

  async resolveAccount({ input, signal }: ResolveAccountInput): Promise<Account> {
    const ref = parseChannelInput(input);
    const collectedAt = new Date().toISOString();
    const part = 'snippet,statistics,contentDetails';
    let query: Record<string, string>;
    switch (ref.kind) {
      case 'id':
        query = { part, id: ref.value };
        break;
      case 'handle':
      case 'custom': // Legacy /c/ custom URLs have no lookup endpoint; most match the handle. Verified result only.
        query = { part, forHandle: ref.value.startsWith('@') ? ref.value : `@${ref.value}` };
        break;
      case 'username':
        query = { part, forUsername: ref.value };
        break;
      case 'video': {
        const v = await this.call('videos', { part: 'snippet', id: ref.value }, videoListResponse, this.costs.list, signal);
        const channelId = v.items?.[0]?.snippet?.channelId;
        if (!channelId) throw new CollectorError('NOT_FOUND', `Video not found or private: ${ref.value}`);
        query = { part, id: channelId };
        break;
      }
    }
    const r = await this.call('channels', query, channelListResponse, this.costs.list, signal);
    const c = r.items?.[0];
    if (!c) {
      const hint = ref.kind === 'custom' ? ' (legacy /c/ URL: no direct lookup; provide the channel ID or @handle)' : '';
      throw new CollectorError('NOT_FOUND', `Channel not found for ${ref.kind}=${ref.value}${hint}`);
    }
    this.rememberUploads(c);
    this.http.meter.addRecords(1);
    return normalizeChannel(c, 'channels.list', collectedAt);
  }

  private rememberUploads(c: { id: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }): void {
    const u = c.contentDetails?.relatedPlaylists?.uploads;
    if (u) this.uploadsPlaylist.set(c.id, u);
  }

  private searchQuery(v: z.infer<typeof searchInputSchema>, type: 'video' | 'channel') {
    return {
      part: 'snippet',
      type,
      q: v.query,
      maxResults: Math.min(v.limit ?? 25, MAX_PAGE),
      pageToken: v.cursor ?? undefined,
      relevanceLanguage: v.language,
      regionCode: v.region?.toUpperCase(),
      publishedAfter: v.since,
      publishedBefore: v.until,
      safeSearch: 'none',
    };
  }

  async searchAccounts(input: SearchInput): Promise<Page<Account>> {
    const v = validateInput(searchInputSchema, input, 'youtube.searchAccounts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot();
    this.searchCalls += 1;
    const s = await this.call('search', this.searchQuery(v, 'channel'), searchListResponse, this.costs.search, input.signal);
    const ids = (s.items ?? []).map((i) => i.id.channelId).filter((x): x is string => Boolean(x));
    let items: Account[] = [];
    if (ids.length) {
      // Enrich in one batched call (1 unit for up to 50 IDs) so metrics are real, not search snippets.
      const c = await this.call('channels', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: MAX_PAGE }, channelListResponse, this.costs.list, input.signal);
      const byId = new Map((c.items ?? []).map((x) => [x.id, x]));
      items = ids.flatMap((id) => {
        const ch = byId.get(id);
        if (!ch) return [];
        this.rememberUploads(ch);
        return [normalizeChannel(ch, 'search.list+channels.list', collectedAt)];
      });
    }
    const warnings = ['search.list results are relevance-ranked and approximate; totalResults is an estimate.'];
    return this.page(items, s.nextPageToken, collectedAt, before, warnings);
  }

  async searchPosts(input: SearchInput): Promise<Page<Post>> {
    const v = validateInput(searchInputSchema, input, 'youtube.searchPosts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot();
    this.searchCalls += 1;
    const s = await this.call('search', this.searchQuery(v, 'video'), searchListResponse, this.costs.search, input.signal);
    const ids = (s.items ?? []).map((i) => i.id.videoId).filter((x): x is string => Boolean(x));
    const { items, missing } = await this.fetchVideos(ids, collectedAt, 'search.list+videos.list', input.signal);
    const warnings = ['search.list results are relevance-ranked and approximate; totalResults is an estimate.'];
    if (missing) warnings.push(`${missing} search hit(s) not returned by videos.list (private/removed).`);
    return this.page(items, s.nextPageToken, collectedAt, before, warnings);
  }

  private async fetchVideos(ids: string[], collectedAt: string, source: string, signal?: AbortSignal) {
    const items: Post[] = [];
    for (let i = 0; i < ids.length; i += MAX_PAGE) {
      const chunk = ids.slice(i, i + MAX_PAGE);
      const r = await this.call('videos', { part: 'snippet,contentDetails,statistics,status', id: chunk.join(','), maxResults: MAX_PAGE }, videoListResponse, this.costs.list, signal);
      const byId = new Map((r.items ?? []).map((x) => [x.id, x]));
      for (const id of chunk) {
        const vid = byId.get(id);
        if (vid) items.push(normalizeVideo(vid, source, collectedAt));
      }
    }
    return { items, missing: ids.length - items.length };
  }

  async getProfile(accountExternalId: string, signal?: AbortSignal): Promise<Account> {
    return this.resolveAccount({ input: accountExternalId, signal });
  }

  async listPosts(input: ListPostsInput): Promise<Page<Post>> {
    const v = validateInput(listInputSchema, input, 'youtube.listPosts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot();
    let uploads = this.uploadsPlaylist.get(input.accountExternalId);
    if (!uploads) {
      await this.resolveAccount({ input: input.accountExternalId, signal: input.signal });
      uploads = this.uploadsPlaylist.get(input.accountExternalId);
    }
    if (!uploads) throw new CollectorError('NOT_FOUND', `No uploads playlist for channel ${input.accountExternalId}`);
    const pl = await this.call('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: Math.min(v.limit ?? 20, MAX_PAGE), pageToken: v.cursor ?? undefined }, playlistItemsResponse, this.costs.list, input.signal);
    const ids = (pl.items ?? []).map((i) => i.contentDetails.videoId);
    const { items, missing } = await this.fetchVideos(ids, collectedAt, 'playlistItems.list+videos.list', input.signal);
    const warnings: string[] = [];
    if (missing) warnings.push(`${missing} upload(s) not returned by videos.list (private/removed/processing).`);
    return this.page(items, pl.nextPageToken, collectedAt, before, warnings);
  }

  async getPostDetail(postExternalId: string, signal?: AbortSignal): Promise<Post> {
    const ref = /^[0-9A-Za-z_-]{11}$/.test(postExternalId) ? postExternalId : (() => {
      const r = parseChannelInput(postExternalId);
      if (r.kind !== 'video') throw new CollectorError('INVALID_INPUT', `Not a video ID/URL: ${postExternalId}`);
      return r.value;
    })();
    const collectedAt = new Date().toISOString();
    const { items } = await this.fetchVideos([ref], collectedAt, 'videos.list', signal);
    const p = items[0];
    if (!p) throw new CollectorError('NOT_FOUND', `Video not returned (deleted, private or never existed): ${ref}`);
    this.http.meter.addRecords(1);
    return p;
  }

  async getPostMetrics(postExternalIds: string[], signal?: AbortSignal): Promise<PostMetrics[]> {
    if (postExternalIds.length > 500) throw new CollectorError('INVALID_INPUT', 'Max 500 video IDs per call');
    const out: PostMetrics[] = [];
    for (let i = 0; i < postExternalIds.length; i += MAX_PAGE) {
      const collectedAt = new Date().toISOString();
      const r = await this.call('videos', { part: 'statistics', id: postExternalIds.slice(i, i + MAX_PAGE).join(','), maxResults: MAX_PAGE }, videoListResponse, this.costs.list, signal);
      for (const v of r.items ?? []) out.push(normalizeVideoMetrics(v, collectedAt));
    }
    this.http.meter.addRecords(out.length);
    return out;
  }

  async listComments(input: ListCommentsInput): Promise<Page<Comment>> {
    const v = validateInput(listInputSchema, input, 'youtube.listComments');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot();
    const r = await this.call('commentThreads', { part: 'snippet', videoId: input.postExternalId, maxResults: Math.min(v.limit ?? 20, 100), pageToken: v.cursor ?? undefined, order: 'relevance', textFormat: 'plainText' }, commentThreadsResponse, this.costs.list, input.signal);
    const items: Comment[] = (r.items ?? []).map((t) => {
      const c = t.snippet.topLevelComment;
      return {
        platform: 'youtube',
        externalId: c.id,
        postExternalId: input.postExternalId,
        authorExternalId: c.snippet.authorChannelId?.value ?? null,
        text: c.snippet.textOriginal ?? c.snippet.textDisplay ?? null,
        publishedAt: c.snippet.publishedAt ?? null,
        likes: c.snippet.likeCount ?? null,
        provenance: provenance('commentThreads.list', collectedAt),
      };
    });
    return this.page(items, r.nextPageToken, collectedAt, before, ['Top-level comments only. Comment text storage is policy-gated (30-day rule; deny by default).']);
  }

  private page<T>(items: T[], cursor: string | undefined, collectedAt: string, before: { requests: number; quotaUnits: number }, warnings: string[]): Page<T> {
    this.http.meter.addRecords(items.length);
    const now = this.http.meter.snapshot();
    return {
      items,
      nextCursor: cursor ?? null,
      collectedAt,
      usage: { requests: now.requests - before.requests, records: items.length, quotaUnits: now.quotaUnits - before.quotaUnits, costUsd: 0 },
      warnings,
    };
  }
}
