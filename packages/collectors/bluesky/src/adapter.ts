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
import { z } from 'zod';
import {
  PROVIDER_ID,
  normalizePost,
  normalizeProfile,
  normalizeMetrics,
  parseActorInput,
  parseAtUri,
  provenance,
} from './normalize.ts';
import {
  authorFeedResponse,
  createSessionResponse,
  getPostThreadResponse,
  getPostsResponse,
  postView,
  profileDetailed,
  resolveHandleResponse,
  searchActorsResponse,
  searchPostsResponse,
  type PostView,
} from './schemas.ts';

export const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
export const APPVIEW = 'https://api.bsky.app';
export const ENTRYWAY = 'https://bsky.social';
const APPVIEW_PROXY = 'did:web:api.bsky.app#bsky_appview';

export interface BlueskyAdapterOptions {
  meter: UsageMeter;
  /** Optional: handle/email + App Password, enables the documented authenticated search path. */
  identifier?: string;
  appPassword?: string;
  /**
   * Unauthenticated searchPosts fallback host. public.api.bsky.app returned 403 for searchPosts
   * on 2026-11-26 while api.bsky.app returned 200. This behaviour is undocumented -> PARTIAL.
   */
  unauthenticatedSearchHost?: string;
  timeoutMs?: number;
  onLog?: (e: RequestLogEntry) => void;
  /** Base URL overrides (tests only). */
  baseUrls?: { publicAppView?: string; appView?: string; entryway?: string };
  allowedHosts?: string[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Map XRPC error bodies ({error, message}) to normalized codes. */
export function classifyBlueskyError(res: RawErrorResponse): CollectorError {
  const body = (res.body ?? {}) as { error?: string; message?: string };
  const err = body.error ?? '';
  const msg = body.message ?? res.text.slice(0, 200);
  const opts = { httpStatus: res.status, providerReason: err || undefined, retryAfterMs: parseRetryAfter(res.headers) };
  if (err === 'ExpiredToken') return new CollectorError('AUTH_EXPIRED', msg, opts);
  if (['AuthenticationRequired', 'InvalidToken', 'AuthMissing'].includes(err)) {
    return new CollectorError('AUTH_REQUIRED', msg, opts);
  }
  if (['AccountTakedown', 'AccountDeactivated', 'BlockedActor', 'BlockedByActor'].includes(err)) {
    return new CollectorError('PRIVATE_OR_REMOVED', msg, opts);
  }
  if (err === 'NotFound' || /not found/i.test(msg)) return new CollectorError('NOT_FOUND', msg, opts);
  if (err === 'RateLimitExceeded' || res.status === 429) return new CollectorError('RATE_LIMITED', msg, opts);
  if (res.status === 400 && err === 'InvalidRequest') return new CollectorError('INVALID_INPUT', msg, opts);
  return defaultClassify(res);
}

const DEFAULT_LIMIT = 25;

export class BlueskyAdapter implements PlatformAdapter {
  readonly platform = 'bluesky' as const;
  readonly providerId = PROVIDER_ID;
  private readonly http: HttpClient;
  private readonly urls: { publicAppView: string; appView: string; entryway: string };
  private session: { accessJwt: string; did: string } | null = null;

  constructor(private readonly opts: BlueskyAdapterOptions) {
    this.urls = {
      publicAppView: opts.baseUrls?.publicAppView ?? PUBLIC_APPVIEW,
      appView: opts.baseUrls?.appView ?? opts.unauthenticatedSearchHost ?? APPVIEW,
      entryway: opts.baseUrls?.entryway ?? ENTRYWAY,
    };
    this.http = new HttpClient({
      providerId: PROVIDER_ID,
      baseUrl: this.urls.publicAppView,
      meter: opts.meter,
      allowedHosts:
        opts.allowedHosts ?? [new URL(this.urls.publicAppView).hostname, new URL(this.urls.appView).hostname, new URL(this.urls.entryway).hostname],
      timeoutMs: opts.timeoutMs ?? 15_000,
      classifyError: classifyBlueskyError,
      onLog: opts.onLog,
      sleep: opts.sleep,
    });
  }

  get hasCredentials(): boolean {
    return Boolean(this.opts.identifier && this.opts.appPassword);
  }

  async getCapabilities(): Promise<Capabilities> {
    // Values confirmed by the Phase 0 PoC (docs/feasibility/bluesky.md). Search is PARTIAL
    // without credentials because the unauthenticated path is undocumented.
    return {
      resolveAccount: 'SUPPORTED',
      searchAccounts: 'SUPPORTED',
      searchPosts: this.hasCredentials ? 'SUPPORTED' : 'PARTIAL',
      getProfile: 'SUPPORTED',
      listPosts: 'SUPPORTED',
      getPostDetail: 'SUPPORTED',
      getPostMetrics: 'SUPPORTED',
      listComments: 'PARTIAL',
    };
  }

  private async get<S extends z.ZodType>(
    nsid: string,
    query: Record<string, string | number | boolean | undefined | string[]>,
    schema: S,
    opts: { signal?: AbortSignal; baseUrl?: string; auth?: boolean } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = {};
    if (opts.auth) {
      const s = await this.ensureSession(opts.signal);
      headers['authorization'] = `Bearer ${s.accessJwt}`;
      headers['atproto-proxy'] = APPVIEW_PROXY;
    }
    const res = await this.http.request({
      path: `/xrpc/${nsid}`,
      query,
      headers,
      signal: opts.signal,
      baseUrl: opts.baseUrl,
    });
    return parseResponse(schema, res.data, nsid);
  }

  private async ensureSession(signal?: AbortSignal): Promise<{ accessJwt: string; did: string }> {
    if (this.session) return this.session;
    if (!this.hasCredentials) throw new CollectorError('AUTH_REQUIRED', 'Bluesky App Password not configured');
    const res = await this.http.request({
      method: 'POST',
      baseUrl: this.urls.entryway,
      path: '/xrpc/com.atproto.server.createSession',
      body: { identifier: this.opts.identifier, password: this.opts.appPassword },
      signal,
    });
    const s = parseResponse(createSessionResponse, res.data, 'createSession');
    this.session = { accessJwt: s.accessJwt, did: s.did };
    return this.session;
  }

  async validateCredentials(): Promise<CredentialStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.hasCredentials) {
      return {
        state: 'NOT_REQUIRED',
        message: 'Public AppView reads need no credentials; App Password not set (authenticated search disabled).',
        checkedAt,
      };
    }
    try {
      this.session = null;
      await this.ensureSession();
      return { state: 'VALID', message: 'createSession succeeded', checkedAt };
    } catch (e) {
      const ce = e as CollectorError;
      const state =
        ce.code === 'AUTH_REQUIRED' || ce.httpStatus === 401
          ? 'INVALID'
          : ce.code === 'AUTH_EXPIRED'
            ? 'EXPIRED'
            : ce.code === 'RATE_LIMITED'
              ? 'QUOTA_EXCEEDED'
              : 'UNKNOWN';
      return { state, message: `${ce.code}: ${ce.message}`, checkedAt };
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    try {
      await this.get('_health', {}, z.looseObject({ version: z.string() }));
      return { healthy: true, latencyMs: Math.round(performance.now() - started), message: 'ok', checkedAt };
    } catch (e) {
      return { healthy: false, latencyMs: null, message: String((e as Error).message), checkedAt };
    }
  }

  async resolveAccount({ input, signal }: ResolveAccountInput): Promise<Account> {
    const actor = parseActorInput(input);
    return this.getProfile(actor.value, signal);
  }

  /** Resolve a handle to its DID (the stable ID). */
  async resolveHandle(handle: string, signal?: AbortSignal): Promise<string> {
    const r = await this.get('com.atproto.identity.resolveHandle', { handle }, resolveHandleResponse, { signal });
    return r.did;
  }

  async searchAccounts(input: SearchInput): Promise<Page<Account>> {
    const v = validateInput(searchInputSchema, input, 'bluesky.searchAccounts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot().requests;
    const r = await this.get(
      'app.bsky.actor.searchActors',
      { q: v.query, limit: v.limit ?? DEFAULT_LIMIT, cursor: v.cursor ?? undefined },
      searchActorsResponse,
      { signal: input.signal },
    );
    const items = r.actors.map((a) => normalizeProfile(a, 'app.bsky.actor.searchActors', collectedAt));
    const warnings: string[] = [];
    if (v.language || v.region) warnings.push('searchActors ignores language/region filters.');
    warnings.push('searchActors returns profiles without follower/post counts (metrics=null). Call getProfile to enrich.');
    return this.page(items, r.cursor, collectedAt, before, warnings);
  }

  async searchPosts(input: SearchInput): Promise<Page<Post>> {
    const v = validateInput(searchInputSchema, input, 'bluesky.searchPosts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot().requests;
    const warnings: string[] = [];
    const query = {
      q: v.query,
      limit: v.limit ?? DEFAULT_LIMIT,
      cursor: v.cursor ?? undefined,
      lang: v.language,
      since: v.since,
      until: v.until,
      sort: 'latest',
    };
    if (v.region) warnings.push('searchPosts has no region/market filter; region ignored.');
    let r: z.infer<typeof searchPostsResponse>;
    if (this.hasCredentials) {
      r = await this.get('app.bsky.feed.searchPosts', query, searchPostsResponse, { signal: input.signal, auth: true });
    } else {
      warnings.push(
        `Unauthenticated searchPosts via ${new URL(this.urls.appView).hostname} (undocumented; may start requiring auth). Configure BLUESKY_APP_PASSWORD for the documented path.`,
      );
      r = await this.get('app.bsky.feed.searchPosts', query, searchPostsResponse, {
        signal: input.signal,
        baseUrl: this.urls.appView,
      });
    }
    const items = r.posts.map((p) => normalizePost(p, 'app.bsky.feed.searchPosts', collectedAt));
    if (r.cursor) warnings.push('searchPosts cursor may not page through the entire result set (per API docs).');
    return this.page(items, r.cursor, collectedAt, before, warnings);
  }

  async getProfile(accountExternalId: string, signal?: AbortSignal): Promise<Account> {
    const collectedAt = new Date().toISOString();
    const p = await this.get('app.bsky.actor.getProfile', { actor: accountExternalId }, profileDetailed, { signal });
    this.http.meter.addRecords(1);
    return normalizeProfile(p, 'app.bsky.actor.getProfile', collectedAt);
  }

  async listPosts(input: ListPostsInput): Promise<Page<Post>> {
    const v = validateInput(listInputSchema, input, 'bluesky.listPosts');
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot().requests;
    const r = await this.get(
      'app.bsky.feed.getAuthorFeed',
      {
        actor: input.accountExternalId,
        limit: v.limit ?? DEFAULT_LIMIT,
        cursor: v.cursor ?? undefined,
        filter: 'posts_no_replies',
        includePins: false,
      },
      authorFeedResponse,
      { signal: input.signal },
    );
    const warnings: string[] = [];
    let reposts = 0;
    const items: Post[] = [];
    for (const item of r.feed) {
      // Reposts are other people's content surfaced in this feed — not the account's own posts.
      if (item.reason?.$type === 'app.bsky.feed.defs#reasonRepost') {
        reposts += 1;
        continue;
      }
      items.push(normalizePost(item.post, 'app.bsky.feed.getAuthorFeed', collectedAt));
    }
    if (reposts) warnings.push(`Skipped ${reposts} repost(s) of other accounts' content.`);
    return this.page(items, r.cursor, collectedAt, before, warnings);
  }

  /** Accepts an AT URI or a bsky.app post URL. */
  async toPostUri(postRef: string, signal?: AbortSignal): Promise<string> {
    if (postRef.startsWith('at://')) {
      const { repo, collection, rkey } = parseAtUri(postRef);
      if (repo.startsWith('did:')) return postRef;
      return `at://${await this.resolveHandle(repo, signal)}/${collection}/${rkey}`;
    }
    const a = parseActorInput(postRef);
    if (!a.postRkey) throw new CollectorError('INVALID_INPUT', `Not a post URL: ${postRef}`);
    const did = a.kind === 'did' ? a.value : await this.resolveHandle(a.value, signal);
    return `at://${did}/app.bsky.feed.post/${a.postRkey}`;
  }

  async getPostDetail(postExternalId: string, signal?: AbortSignal): Promise<Post> {
    const uri = await this.toPostUri(postExternalId, signal);
    const collectedAt = new Date().toISOString();
    const r = await this.get('app.bsky.feed.getPosts', { uris: [uri] }, getPostsResponse, { signal });
    const p = r.posts[0];
    if (!p) {
      // getPosts silently omits deleted/unavailable posts; we cannot tell deleted from never-existed.
      throw new CollectorError('NOT_FOUND', `Post not returned by getPosts (deleted, taken down or never existed): ${uri}`);
    }
    this.http.meter.addRecords(1);
    return normalizePost(p, 'app.bsky.feed.getPosts', collectedAt);
  }

  /** Batches of 25 (API max). Posts missing from the response are omitted and reported via missingIds. */
  async getPostMetrics(postExternalIds: string[], signal?: AbortSignal): Promise<PostMetrics[]> {
    if (postExternalIds.length === 0) return [];
    if (postExternalIds.length > 500) throw new CollectorError('INVALID_INPUT', 'Max 500 post IDs per call');
    const uris = await Promise.all(postExternalIds.map((id) => this.toPostUri(id, signal)));
    const out: PostMetrics[] = [];
    for (let i = 0; i < uris.length; i += 25) {
      const collectedAt = new Date().toISOString();
      const r = await this.get('app.bsky.feed.getPosts', { uris: uris.slice(i, i + 25) }, getPostsResponse, { signal });
      for (const p of r.posts) out.push(normalizeMetrics(p, collectedAt));
    }
    this.http.meter.addRecords(out.length);
    return out;
  }

  async listComments(input: ListCommentsInput): Promise<Page<Comment>> {
    const v = validateInput(listInputSchema, input, 'bluesky.listComments');
    if (v.cursor) throw new CollectorError('NOT_SUPPORTED', 'getPostThread has no cursor pagination');
    const uri = await this.toPostUri(input.postExternalId, input.signal);
    const collectedAt = new Date().toISOString();
    const before = this.http.meter.snapshot().requests;
    const r = await this.get('app.bsky.feed.getPostThread', { uri, depth: 1, parentHeight: 0 }, getPostThreadResponse, {
      signal: input.signal,
    });
    const items: Comment[] = [];
    const replies = r.thread.replies ?? [];
    for (const raw of replies) {
      const parsed = z.looseObject({ post: postView }).safeParse(raw);
      if (!parsed.success) continue; // blocked/not-found reply stubs
      const p: PostView = parsed.data.post;
      items.push({
        platform: 'bluesky',
        externalId: p.uri,
        postExternalId: uri,
        authorExternalId: p.author.did,
        text: p.record.text ?? null,
        publishedAt: p.record.createdAt ?? null,
        likes: p.likeCount ?? null,
        provenance: provenance('app.bsky.feed.getPostThread', collectedAt),
      });
      if (items.length >= (v.limit ?? DEFAULT_LIMIT)) break;
    }
    const warnings = ['Top-level replies only (depth=1); no cursor pagination. Comment storage is policy-gated (deny by default).'];
    return this.page(items, null, collectedAt, before, warnings);
  }

  private page<T>(items: T[], cursor: string | undefined | null, collectedAt: string, reqBefore: number, warnings: string[]): Page<T> {
    this.http.meter.addRecords(items.length);
    return {
      items,
      nextCursor: cursor ?? null,
      collectedAt,
      usage: { requests: this.http.meter.snapshot().requests - reqBefore, records: items.length, costUsd: 0 },
      warnings,
    };
  }
}
