/**
 * Normalized collector error codes (Master Plan §5.3).
 * Adapters MUST throw CollectorError instead of returning empty results to hide failures.
 */
export const ERROR_CODES = [
  'NOT_SUPPORTED',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'BUDGET_EXCEEDED',
  'NOT_FOUND',
  'PRIVATE_OR_REMOVED',
  'PROVIDER_UNAVAILABLE',
  'SCHEMA_CHANGED',
  'POLICY_BLOCKED',
  'TIMEOUT',
  'INVALID_INPUT',
  'UNKNOWN_ERROR',
] as const;

export type CollectorErrorCode = (typeof ERROR_CODES)[number];

/** Transient errors that may be retried automatically (with backoff). */
const RETRYABLE: ReadonlySet<CollectorErrorCode> = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
]);

export function isRetryableCode(code: CollectorErrorCode): boolean {
  return RETRYABLE.has(code);
}

export interface CollectorErrorOptions {
  httpStatus?: number;
  /** Provider-specific reason string (e.g. YouTube "quotaExceeded"). */
  providerReason?: string;
  /** Milliseconds the provider asked us to wait (Retry-After). */
  retryAfterMs?: number;
  providerRequestId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerReason: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly providerRequestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CollectorErrorCode, message: string, opts: CollectorErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CollectorError';
    this.code = code;
    this.retryable = isRetryableCode(code);
    this.httpStatus = opts.httpStatus;
    this.providerReason = opts.providerReason;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerRequestId = opts.providerRequestId;
    this.details = opts.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      providerReason: this.providerReason,
      retryAfterMs: this.retryAfterMs,
      providerRequestId: this.providerRequestId,
    };
  }
}

export function isCollectorError(e: unknown): e is CollectorError {
  return e instanceof CollectorError;
}

/** Wrap any thrown value into a CollectorError (never loses the original as `cause`). */
export function toCollectorError(e: unknown): CollectorError {
  if (isCollectorError(e)) return e;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return new CollectorError('TIMEOUT', e.message, { cause: e });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new CollectorError('UNKNOWN_ERROR', msg, { cause: e });
}

export function notSupported(platform: string, method: string, reason: string): CollectorError {
  return new CollectorError('NOT_SUPPORTED', `${platform}.${method} is not supported: ${reason}`);
}
