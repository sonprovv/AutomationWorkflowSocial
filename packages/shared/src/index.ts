import { z } from 'zod';
import { CollectorError, ERROR_CODES, type CollectorErrorCode, type Platform } from '@sss/collector-core';

/* ------------------------------------------------------------------ */
/* Job / run states (Master Plan §7.1)                                 */
/* ------------------------------------------------------------------ */
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING'];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'];

/* ------------------------------------------------------------------ */
/* API error envelope (Master Plan §11)                                */
/* ------------------------------------------------------------------ */
export const API_ERROR_CODES = [...ERROR_CODES, 'CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: Record<string, unknown>; requestId?: string };
}

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  INVALID_INPUT: 400,
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  PERMISSION_DENIED: 403,
  POLICY_BLOCKED: 403,
  NOT_FOUND: 404,
  PRIVATE_OR_REMOVED: 410,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  BUDGET_EXCEEDED: 429,
  NOT_SUPPORTED: 422,
  SCHEMA_CHANGED: 502,
  PROVIDER_UNAVAILABLE: 502,
  TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
};

export function httpStatusFor(code: ApiErrorCode): number {
  return STATUS[code] ?? 500;
}

/** Convert any thrown value into (status, envelope). Never leaks stack traces or secrets. */
export function toApiError(e: unknown, requestId?: string): { status: number; body: ApiErrorBody } {
  if (e instanceof AppError) {
    return { status: httpStatusFor(e.code), body: { error: { code: e.code, message: e.message, details: e.details, requestId } } };
  }
  if (e instanceof CollectorError) {
    const details: Record<string, unknown> = {};
    if (e.providerReason) details.providerReason = e.providerReason;
    if (e.retryAfterMs !== undefined) details.retryAfterMs = e.retryAfterMs;
    return {
      status: httpStatusFor(e.code),
      body: { error: { code: e.code, message: e.message, details: Object.keys(details).length ? details : undefined, requestId } },
    };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } } };
}

export function isCollectorErrorCode(c: string): c is CollectorErrorCode {
  return (ERROR_CODES as readonly string[]).includes(c);
}

/* ------------------------------------------------------------------ */
/* Cursor pagination (opaque, tamper-evident enough for local use)     */
/* ------------------------------------------------------------------ */
export function encodeCursor(v: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(cursor: string | undefined | null, schema: T): z.infer<T> | null {
  if (!cursor) return null;
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (r.success) return r.data;
  } catch {
    /* fallthrough */
  }
  throw new AppError('INVALID_INPUT', 'Invalid cursor');
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Platform detection from user input                                  */
/* ------------------------------------------------------------------ */
const HOST_PLATFORM: Record<string, Platform> = {
  'bsky.app': 'bluesky',
  'www.bsky.app': 'bluesky',
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'm.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'www.tiktok.com': 'tiktok',
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'threads.net': 'threads',
  'www.threads.net': 'threads',
  'threads.com': 'threads',
  'www.threads.com': 'threads',
  'x.com': 'x',
  'twitter.com': 'x',
  'reddit.com': 'reddit',
  'www.reddit.com': 'reddit',
  'pinterest.com': 'pinterest',
  'www.pinterest.com': 'pinterest',
  'linkedin.com': 'linkedin',
  'www.linkedin.com': 'linkedin',
};

/** Detect platform from a URL or a DID. Returns null when ambiguous (e.g. a bare @handle). */
export function detectPlatform(input: string): Platform | null {
  const s = input.trim();
  if (/^did:(plc|web):/.test(s)) return 'bluesky';
  if (/^UC[0-9A-Za-z_-]{22}$/.test(s)) return 'youtube';
  try {
    const u = new URL(s);
    return HOST_PLATFORM[u.hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Spreadsheet formula-injection guard (Master Plan §12) — shared now   */
/* ------------------------------------------------------------------ */
export function neutralizeFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
