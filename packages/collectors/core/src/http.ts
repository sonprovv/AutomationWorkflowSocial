import { CollectorError, toCollectorError } from './errors.ts';
import type { UsageMeter } from './meter.ts';
import { redactUrl } from './redact.ts';

export interface RequestLogEntry {
  ts: string;
  providerId: string;
  method: string;
  /** Redacted URL — never contains secrets. */
  url: string;
  status: number | null;
  latencyMs: number;
  attempt: number;
  quotaUnits: number;
  errorCode?: string;
  providerReason?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface RawErrorResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export type ErrorClassifier = (res: RawErrorResponse) => CollectorError;

export interface HttpClientOptions {
  providerId: string;
  baseUrl: string;
  meter: UsageMeter;
  /** SSRF guard: only these hostnames may be contacted. */
  allowedHosts: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** If the provider asks us to wait longer than this, fail fast with RATE_LIMITED instead of sleeping. */
  maxRetryWaitMs?: number;
  classifyError?: ErrorClassifier;
  requestIdHeader?: string;
  onLog?: (entry: RequestLogEntry) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Provider quota units this request costs (e.g. YouTube search.list = 100). */
  quotaUnits?: number;
  costUsd?: number;
  signal?: AbortSignal;
  /** Override base URL (must still be on the allowlist). */
  baseUrl?: string;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  latencyMs: number;
  attempts: number;
}

export function defaultClassify(res: RawErrorResponse): CollectorError {
  const s = res.status;
  const opts = { httpStatus: s, retryAfterMs: parseRetryAfter(res.headers) };
  const snippet = res.text.slice(0, 300);
  if (s === 400) return new CollectorError('INVALID_INPUT', `Bad request: ${snippet}`, opts);
  if (s === 401) return new CollectorError('AUTH_REQUIRED', `Unauthorized: ${snippet}`, opts);
  if (s === 403) return new CollectorError('PERMISSION_DENIED', `Forbidden: ${snippet}`, opts);
  if (s === 404) return new CollectorError('NOT_FOUND', `Not found: ${snippet}`, opts);
  if (s === 408) return new CollectorError('TIMEOUT', `Request timeout`, opts);
  if (s === 410) return new CollectorError('PRIVATE_OR_REMOVED', `Gone: ${snippet}`, opts);
  if (s === 429) return new CollectorError('RATE_LIMITED', `Rate limited: ${snippet}`, opts);
  if (s >= 500) return new CollectorError('PROVIDER_UNAVAILABLE', `Provider error ${s}: ${snippet}`, opts);
  return new CollectorError('UNKNOWN_ERROR', `Unexpected HTTP ${s}: ${snippet}`, opts);
}

/**
 * Parse wait hints: standard `Retry-After` (seconds or HTTP-date) and the IETF draft
 * `RateLimit-Reset` (Bluesky sends epoch seconds). Returns ms or undefined.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = headers.get('ratelimit-reset');
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      // Heuristic: values > 1e9 are epoch seconds, otherwise delta seconds.
      return Math.max(0, n > 1e9 ? n * 1000 - now : n * 1000);
    }
  }
  return undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class HttpClient {
  private readonly o: Required<
    Omit<HttpClientOptions, 'onLog' | 'requestIdHeader' | 'headers' | 'classifyError'>
  > &
    Pick<HttpClientOptions, 'onLog' | 'requestIdHeader'> & {
      headers: Record<string, string>;
      classifyError: ErrorClassifier;
    };

  constructor(opts: HttpClientOptions) {
    this.o = {
      timeoutMs: 15_000,
      maxRetries: 3,
      maxRetryWaitMs: 30_000,
      sleep: defaultSleep,
      fetchImpl: globalThis.fetch.bind(globalThis),
      random: Math.random,
      ...opts,
      headers: opts.headers ?? {},
      classifyError: opts.classifyError ?? defaultClassify,
    };
  }

  get meter(): UsageMeter {
    return this.o.meter;
  }

  buildUrl(path: string, query?: RequestOptions['query'], baseUrl?: string): URL {
    const url = new URL(path, baseUrl ?? this.o.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else url.searchParams.set(k, String(v));
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new CollectorError('POLICY_BLOCKED', `Only HTTPS is allowed: ${redactUrl(url.toString())}`);
    }
    if (!this.o.allowedHosts.includes(url.hostname)) {
      throw new CollectorError('POLICY_BLOCKED', `Host not on allowlist: ${url.hostname}`);
    }
    return url;
  }

  async request<T = unknown>(req: RequestOptions): Promise<HttpResponse<T>> {
    const url = this.buildUrl(req.path, req.query, req.baseUrl);
    const method = req.method ?? 'GET';
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      const reservation = this.o.meter.reserve({ quotaUnits: req.quotaUnits, costUsd: req.costUsd });
      const started = performance.now();
      const timeout = AbortSignal.timeout(this.o.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let status: number | null = null;
      let err: CollectorError | undefined;
      let result: HttpResponse<T> | undefined;
      let requestId: string | undefined;
      try {
        const res = await this.o.fetchImpl(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...this.o.headers,
            ...req.headers,
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal,
          redirect: 'error',
        });
        status = res.status;
        requestId = this.o.requestIdHeader ? (res.headers.get(this.o.requestIdHeader) ?? undefined) : undefined;
        const text = await res.text();
        let body: unknown = undefined;
        let jsonOk = true;
        try {
          body = text.length ? JSON.parse(text) : undefined;
        } catch {
          jsonOk = false;
        }
        if (res.ok) {
          if (!jsonOk) {
            err = new CollectorError('SCHEMA_CHANGED', `Expected JSON from ${redactUrl(url.toString())}`, {
              httpStatus: status,
            });
          } else {
            result = {
              data: body as T,
              status,
              headers: res.headers,
              latencyMs: Math.round(performance.now() - started),
              attempts: attempt,
            };
          }
        } else {
          err = this.o.classifyError({ status, headers: res.headers, body, text });
        }
      } catch (e) {
        if (req.signal?.aborted) {
          err = new CollectorError('TIMEOUT', 'Request cancelled by caller', { cause: e });
        } else if (timeout.aborted) {
          err = new CollectorError('TIMEOUT', `Timed out after ${this.o.timeoutMs}ms`, { cause: e });
        } else {
          const ce = toCollectorError(e);
          err =
            ce.code === 'UNKNOWN_ERROR'
              ? new CollectorError('PROVIDER_UNAVAILABLE', `Network error: ${ce.message}`, { cause: e })
              : ce;
        }
      }
      // Quota is charged by providers like YouTube even for failed requests.
      reservation.commit();
      const latencyMs = Math.round(performance.now() - started);
      this.o.onLog?.({
        ts: new Date().toISOString(),
        providerId: this.o.providerId,
        method,
        url: redactUrl(url.toString()),
        status,
        latencyMs,
        attempt,
        quotaUnits: req.quotaUnits ?? 0,
        errorCode: err?.code,
        providerReason: err?.providerReason,
        providerRequestId: requestId ?? err?.providerRequestId,
        retryAfterMs: err?.retryAfterMs,
      });
      if (result) return result;
      const e = err!;
      const caller = req.signal?.aborted === true;
      if (!e.retryable || caller || attempt > this.o.maxRetries) throw e;
      const backoff = Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(this.o.random() * 250);
      const wait = e.retryAfterMs ?? backoff;
      if (wait > this.o.maxRetryWaitMs) throw e;
      await this.o.sleep(wait, req.signal);
    }
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
