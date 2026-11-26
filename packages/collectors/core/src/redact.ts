/**
 * Secret redaction for logs, run reports and error messages (Master Plan §13).
 */

const SECRET_QUERY_PARAMS = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'client_secret',
  'password',
  'refresh_token',
]);

const SECRET_HEADERS = new Set([
  'authorization',
  'x-goog-api-key',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

export const REDACTED = '[REDACTED]';

/** Registry of literal secret values that must never appear in output. */
export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string | undefined | null): void {
    // Very short values would cause over-redaction of normal text; real keys are long.
    if (value && value.length >= 8) this.values.add(value);
  }

  redactText(text: string): string {
    let out = text;
    for (const v of this.values) out = out.split(v).join(REDACTED);
    return out;
  }
}

export const globalSecrets = new SecretRegistry();

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return globalSecrets.redactText(raw);
  }
  for (const k of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(k.toLowerCase())) url.searchParams.set(k, REDACTED);
  }
  if (url.password) url.password = REDACTED;
  return globalSecrets.redactText(url.toString());
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : globalSecrets.redactText(v);
  }
  return out;
}

/** Deep-redact any JSON-like value: secret-looking keys and registered secret values. */
export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

const SECRET_KEY_RE = /(^|_|-)(password|secret|token|api[_-]?key|authorization|accessjwt|refreshjwt)$/i;

function walk(v: unknown): unknown {
  if (typeof v === 'string') return globalSecrets.redactText(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof val === 'string' ? REDACTED : walk(val);
    }
    return out;
  }
  return v;
}
