import { afterEach, describe, expect, it } from 'vitest';
import {
  CollectorError,
  HttpClient,
  UsageMeter,
  extractHashtags,
  globalSecrets,
  isoDurationToSeconds,
  parseRetryAfter,
  redactDeep,
  redactHeaders,
  redactUrl,
  searchInputSchema,
  toCount,
  validateInput,
  type RequestLogEntry,
} from '../src/index.ts';
import { startFakeServer, type FakeServer } from '../src/testing.ts';

describe('errors', () => {
  it('marks only transient codes retryable', () => {
    expect(new CollectorError('RATE_LIMITED', 'x').retryable).toBe(true);
    expect(new CollectorError('PROVIDER_UNAVAILABLE', 'x').retryable).toBe(true);
    expect(new CollectorError('TIMEOUT', 'x').retryable).toBe(true);
    for (const c of ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'QUOTA_EXCEEDED', 'POLICY_BLOCKED', 'BUDGET_EXCEEDED'] as const) {
      expect(new CollectorError(c, 'x').retryable).toBe(false);
    }
  });
});

describe('redaction', () => {
  it('redacts secret query params and headers', () => {
    expect(redactUrl('https://x.test/a?key=SECRETKEY123&q=1')).toBe('https://x.test/a?key=%5BREDACTED%5D&q=1');
    expect(redactHeaders({ Authorization: 'Bearer abc', 'X-Goog-Api-Key': 'k', accept: 'json' })).toEqual({
      Authorization: '[REDACTED]',
      'X-Goog-Api-Key': '[REDACTED]',
      accept: 'json',
    });
  });
  it('redacts registered secret values anywhere, and secret-looking keys', () => {
    globalSecrets.add('super-secret-value-xyz');
    expect(redactDeep({ msg: 'oops super-secret-value-xyz leaked', nested: { accessJwt: 'jwt', ok: 1 } })).toEqual({
      msg: 'oops [REDACTED] leaked',
      nested: { accessJwt: '[REDACTED]', ok: 1 },
    });
  });
});

describe('UsageMeter', () => {
  it('enforces request and quota caps before the call', () => {
    const m = new UsageMeter({ maxRequests: 2, maxQuotaUnits: 150 });
    m.reserve({ quotaUnits: 100 }).commit();
    expect(() => m.reserve({ quotaUnits: 100 })).toThrowError(/quota-unit cap/);
    m.reserve({ quotaUnits: 1 }).commit();
    expect(() => m.reserve({ quotaUnits: 0 })).toThrowError(/request cap/);
    expect(m.snapshot()).toMatchObject({ requests: 2, quotaUnits: 101 });
  });
  it('counts outstanding reservations so concurrent callers cannot overspend', () => {
    const m = new UsageMeter({ maxQuotaUnits: 100 });
    const a = m.reserve({ quotaUnits: 60 });
    expect(() => m.reserve({ quotaUnits: 60 })).toThrow(CollectorError);
    a.release();
    m.reserve({ quotaUnits: 60 }).commit();
    expect(m.snapshot().quotaUnits).toBe(60);
  });
});

describe('validation helpers', () => {
  it('toCount keeps missing as null, never 0', () => {
    expect(toCount(undefined)).toBeNull();
    expect(toCount('')).toBeNull();
    expect(toCount('abc')).toBeNull();
    expect(toCount(-1)).toBeNull();
    expect(toCount('0')).toBe(0);
    expect(toCount('1234')).toBe(1234);
  });
  it('extracts unicode hashtags, ignoring numeric-only and URL fragments', () => {
    expect(extractHashtags('Hình nền #LiveWallpaper #3d #hìnhnền #123 https://x.test/#anchor')).toEqual([
      'livewallpaper',
      '3d',
      'hìnhnền',
    ]);
  });
  it('parses ISO-8601 durations', () => {
    expect(isoDurationToSeconds('PT1M5S')).toBe(65);
    expect(isoDurationToSeconds('PT2H')).toBe(7200);
    expect(isoDurationToSeconds('P1DT1S')).toBe(86401);
    expect(isoDurationToSeconds('garbage')).toBeNull();
  });
  it('rejects invalid search input with INVALID_INPUT', () => {
    expect(() => validateInput(searchInputSchema, { query: '  ' }, 't')).toThrowError(/query/);
    expect(() => validateInput(searchInputSchema, { query: 'a', limit: 1000 }, 't')).toThrow(CollectorError);
    expect(validateInput(searchInputSchema, { query: ' a ', region: 'vn' }, 't').query).toBe('a');
  });
  it('parses Retry-After seconds, HTTP-date and RateLimit-Reset epoch', () => {
    const now = Date.parse('2026-11-26T00:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Thu, 26 Nov 2026 00:00:10 GMT' }), now)).toBe(10_000);
    expect(parseRetryAfter(new Headers({ 'ratelimit-reset': String(now / 1000 + 5) }), now)).toBe(5000);
    expect(parseRetryAfter(new Headers(), now)).toBeUndefined();
  });
});

describe('HttpClient (contract against local fake server)', () => {
  let srv: FakeServer;
  afterEach(async () => srv?.close());

  function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
    const sleeps: number[] = [];
    const logs: RequestLogEntry[] = [];
    const c = new HttpClient({
      providerId: 'fake',
      baseUrl: srv.baseUrl,
      meter: new UsageMeter({ maxRequests: 20 }),
      allowedHosts: ['127.0.0.1'],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      onLog: (e) => logs.push(e),
      ...extra,
    });
    return { c, sleeps, logs };
  }

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let n = 0;
    srv = await startFakeServer({
      '/x': () => (++n < 2 ? { status: 429, headers: { 'retry-after': '2' }, body: {} } : { body: { ok: true } }),
    });
    const { c, sleeps, logs } = client();
    const r = await c.request<{ ok: boolean }>({ path: '/x' });
    expect(r.data.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(logs.map((l) => l.status)).toEqual([429, 200]);
  });

  it('fails fast with RATE_LIMITED when Retry-After exceeds the max wait', async () => {
    srv = await startFakeServer({ '/x': () => ({ status: 429, headers: { 'retry-after': '3600' } }) });
    const { c, sleeps } = client();
    await expect(c.request({ path: '/x' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3_600_000 });
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx with exponential backoff up to maxRetries, then throws PROVIDER_UNAVAILABLE', async () => {
    srv = await startFakeServer({ '/x': () => ({ status: 503, body: {} }) });
    const { c, sleeps } = client({ maxRetries: 3 });
    await expect(c.request({ path: '/x' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(srv.requests).toHaveLength(4);
  });

  it('does not retry permission/auth errors', async () => {
    srv = await startFakeServer({ '/x': () => ({ status: 403, body: {} }) });
    const { c } = client();
    await expect(c.request({ path: '/x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(srv.requests).toHaveLength(1);
  });

  it('maps timeouts to TIMEOUT', async () => {
    srv = await startFakeServer({ '/slow': () => ({ delayMs: 500, body: {} }) });
    const { c } = client({ timeoutMs: 50, maxRetries: 0 });
    await expect(c.request({ path: '/slow' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports non-JSON success bodies as SCHEMA_CHANGED', async () => {
    srv = await startFakeServer({ '/html': () => ({ raw: '<html>maintenance</html>' }) });
    const { c } = client();
    await expect(c.request({ path: '/html' })).rejects.toMatchObject({ code: 'SCHEMA_CHANGED' });
  });

  it('blocks hosts outside the allowlist (SSRF guard) without sending a request', async () => {
    srv = await startFakeServer({});
    const { c } = client();
    await expect(c.request({ path: '/x', baseUrl: 'https://169.254.169.254/' })).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(srv.requests).toHaveLength(0);
  });

  it('throws BUDGET_EXCEEDED before calling the provider', async () => {
    srv = await startFakeServer({ '/x': () => ({ body: {} }) });
    const { c } = client({ meter: new UsageMeter({ maxQuotaUnits: 50 }) });
    await expect(c.request({ path: '/x', quotaUnits: 100 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(srv.requests).toHaveLength(0);
  });

  it('never logs secret query params', async () => {
    srv = await startFakeServer({ '/x': () => ({ body: {} }) });
    const { c, logs } = client();
    await c.request({ path: '/x', query: { key: 'AIzaSECRET-value-123', q: 'ok' } });
    expect(logs[0]!.url).not.toContain('AIzaSECRET');
    expect(logs[0]!.url).toContain('REDACTED');
  });
});
