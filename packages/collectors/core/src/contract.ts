/**
 * Shared adapter contract suite (Master Plan §17.1 "Contract: per adapter, pagination, typed errors,
 * credentials, capability checks, rate limit, removed/private resources").
 *
 * Every production adapter runs the SAME checks against a local fake provider (SYNTHETIC fixtures,
 * no network). Usage in an adapter package test:
 *
 *   runAdapterContract({ name: 'bluesky', create, routes, ... });
 *
 * Test-support module: imports vitest, so only import it from tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_KEYS, type Account, type MissingReason, type PlatformAdapter, type Post, type PostMetrics } from './types.ts';
import { UsageMeter } from './meter.ts';
import { startFakeServer, type FakeRoute, type FakeServer } from './testing.ts';

export interface AdapterContractSpec {
  /** Suite label, e.g. "bluesky". */
  name: string;
  /** Build the adapter against the fake server. `meter` decides the budget. */
  create(o: { baseUrl: string; meter: UsageMeter }): PlatformAdapter;
  /** A meter with enough budget for every scenario. */
  meter(): UsageMeter;
  /** A meter with no budget left. */
  exhaustedMeter(): UsageMeter;
  /** Stable external ID of the fixture account. */
  accountId: string;
  /**
   * Routes for the healthy fixture account: profile, a post list with exactly 2 pages (page 2 only when the
   * request carries the cursor of page 1), and batched metrics that omit `deletedPostId`.
   */
  routes(): Record<string, FakeRoute>;
  /** Routes where the account does not exist. */
  notFoundRoutes(): Record<string, FakeRoute>;
  /** Path the profile lookup calls first (used for error injection). */
  profilePath: string;
  /** Post IDs the metrics endpoint returns, and one it omits (deleted/private on the platform). */
  metricsPostIds: { present: string[]; deleted: string };
  /** A credential value that must never appear in a request URL. */
  secret?: string;
}

const CAPABILITY_STATES = ['SUPPORTED', 'PARTIAL', 'AUTH_REQUIRED', 'NOT_SUPPORTED', 'BLOCKED', 'UNKNOWN'];
const MISSING_REASONS: MissingReason[] = ['NOT_PROVIDED', 'HIDDEN_BY_OWNER', 'NOT_SUPPORTED', 'DISABLED'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function expectCount(v: unknown, label: string) {
  // null = missing/unsupported; never undefined, never a string, never a negative number.
  expect(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0), `${label} must be a count or null, got ${JSON.stringify(v)}`).toBe(true);
}

function expectProvenance(p: { providerId: string; collectedAt: string; policyId: string; schemaVersion: string; source: string }, providerId: string) {
  expect(p.providerId).toBe(providerId);
  expect(p.collectedAt).toMatch(ISO);
  expect(p.policyId.length).toBeGreaterThan(0);
  expect(p.schemaVersion.length).toBeGreaterThan(0);
  expect(p.source.length).toBeGreaterThan(0);
}

function expectMetrics(m: PostMetrics) {
  for (const k of ['views', 'likes', 'comments', 'shares', 'saves'] as const) {
    expectCount(m[k], k);
    const reason = m.missing[k];
    if (reason !== undefined) {
      expect(MISSING_REASONS).toContain(reason);
      expect(m[k], `${k} has a missing reason but a value`).toBeNull();
    }
  }
  for (const [k, v] of Object.entries(m.extra)) expectCount(v, `extra.${k}`);
  expect(m.collectedAt).toMatch(ISO);
}

function expectAccount(a: Account, spec: AdapterContractSpec, adapter: PlatformAdapter) {
  expect(a.platform).toBe(adapter.platform);
  expect(a.externalId).toBe(spec.accountId);
  expect(a.profileUrl).toMatch(/^https:\/\//);
  expectProvenance(a.provenance, adapter.providerId);
  if (a.metrics) {
    expectCount(a.metrics.followers, 'followers');
    expectCount(a.metrics.following, 'following');
    expectCount(a.metrics.postsCount, 'postsCount');
  }
}

function expectPost(p: Post, spec: AdapterContractSpec, adapter: PlatformAdapter) {
  expect(p.platform).toBe(adapter.platform);
  expect(p.externalId.length).toBeGreaterThan(0);
  expect(p.accountExternalId).toBe(spec.accountId);
  expect(p.url).toMatch(/^https:\/\//);
  expect(Array.isArray(p.hashtags)).toBe(true);
  if (p.publishedAt !== null) expect(p.publishedAt).toMatch(ISO);
  expectProvenance(p.provenance, adapter.providerId);
  if (p.metrics) {
    expect(p.metrics.postExternalId).toBe(p.externalId);
    expectMetrics(p.metrics);
  }
}

export function runAdapterContract(spec: AdapterContractSpec): void {
  describe(`adapter contract: ${spec.name}`, () => {
    let srv: FakeServer | undefined;
    afterEach(async () => {
      await srv?.close();
      srv = undefined;
    });
    const setup = async (routes: Record<string, FakeRoute>, meter = spec.meter()) => {
      srv = await startFakeServer(routes);
      return { adapter: spec.create({ baseUrl: srv.baseUrl, meter }), srv, meter };
    };

    it('C01 declares a known state for every capability', async () => {
      const { adapter } = await setup({});
      const caps = await adapter.getCapabilities();
      expect(Object.keys(caps).sort()).toEqual([...CAPABILITY_KEYS].sort());
      for (const k of CAPABILITY_KEYS) expect(CAPABILITY_STATES).toContain(caps[k]);
    });

    it('C02 getProfile returns a canonical account with provenance and null (never 0) for missing counts', async () => {
      const { adapter } = await setup(spec.routes());
      expectAccount(await adapter.getProfile(spec.accountId), spec, adapter);
    });

    it('C03 listPosts pages with an opaque cursor until nextCursor is null, without duplicates', async () => {
      const { adapter } = await setup(spec.routes());
      const p1 = await adapter.listPosts({ accountExternalId: spec.accountId, limit: 2 });
      expect(p1.items.length).toBeGreaterThan(0);
      expect(p1.nextCursor).not.toBeNull();
      expect(p1.collectedAt).toMatch(ISO);
      expect(p1.usage.requests).toBeGreaterThan(0);
      const p2 = await adapter.listPosts({ accountExternalId: spec.accountId, limit: 2, cursor: p1.nextCursor });
      expect(p2.nextCursor).toBeNull();
      const ids = [...p1.items, ...p2.items].map((p) => p.externalId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of [...p1.items, ...p2.items]) expectPost(p, spec, adapter);
    });

    it('C04 getPostMetrics batches, omits posts the provider no longer returns (no zero-filling), and sends nothing for []', async () => {
      const { adapter, srv: s } = await setup(spec.routes());
      expect(await adapter.getPostMetrics([])).toEqual([]);
      expect(s.requests).toHaveLength(0);
      const ids = [...spec.metricsPostIds.present, spec.metricsPostIds.deleted];
      const out = await adapter.getPostMetrics(ids);
      expect(out.map((m) => m.postExternalId).sort()).toEqual([...spec.metricsPostIds.present].sort());
      for (const m of out) expectMetrics(m);
      expect(s.requests.length).toBeLessThanOrEqual(2); // batched, not one call per post
    });

    it('C05 a nonexistent account is a typed NOT_FOUND, not an empty result', async () => {
      const { adapter } = await setup(spec.notFoundRoutes());
      await expect(adapter.getProfile(spec.accountId)).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    });

    it('C06 HTTP 429 becomes RATE_LIMITED (retryable) and honours Retry-After before retrying', async () => {
      let calls = 0;
      const { adapter } = await setup({ ...spec.routes(), [spec.profilePath]: () => (calls++, { status: 429, headers: { 'retry-after': '1' }, body: {} }) });
      await expect(adapter.getProfile(spec.accountId)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(calls).toBeGreaterThan(1); // retried (tests inject a no-op sleep)
    });

    it('C07 5xx becomes PROVIDER_UNAVAILABLE after bounded retries', async () => {
      let calls = 0;
      const { adapter } = await setup({ ...spec.routes(), [spec.profilePath]: () => (calls++, { status: 503, body: {} }) });
      await expect(adapter.getProfile(spec.accountId)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThanOrEqual(5);
    });

    it('C08 a changed response shape is SCHEMA_CHANGED, not silently empty', async () => {
      const { adapter } = await setup({ ...spec.routes(), [spec.profilePath]: () => ({ raw: '<html>not json</html>' }) });
      await expect(adapter.getProfile(spec.accountId)).rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
    });

    it('C09 invalid input is INVALID_INPUT and sends no request', async () => {
      const { adapter, srv: s } = await setup(spec.routes());
      await expect(adapter.listPosts({ accountExternalId: spec.accountId, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(adapter.searchPosts({ query: '' })).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|NOT_SUPPORTED|AUTH_REQUIRED/) });
      expect(s.requests).toHaveLength(0);
    });

    it('C10 a cancelled call stops without retrying', async () => {
      const { adapter, srv: s } = await setup(spec.routes());
      const ac = new AbortController();
      ac.abort(new Error('user cancel'));
      await expect(adapter.getProfile(spec.accountId, ac.signal)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
      expect(s.requests.length).toBeLessThanOrEqual(1);
    });

    it('C11 an exhausted budget is BUDGET_EXCEEDED before any request is sent', async () => {
      const { adapter, srv: s } = await setup(spec.routes(), spec.exhaustedMeter());
      await expect(adapter.getProfile(spec.accountId)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(s.requests).toHaveLength(0);
    });

    it('C12 credentials never appear in request URLs', async () => {
      const { adapter, srv: s } = await setup(spec.routes());
      await adapter.getProfile(spec.accountId);
      await adapter.listPosts({ accountExternalId: spec.accountId, limit: 2 });
      if (spec.secret) for (const r of s.requests) expect(r.url.toString()).not.toContain(spec.secret);
      expect(s.requests.length).toBeGreaterThan(0);
    });
  });
}
