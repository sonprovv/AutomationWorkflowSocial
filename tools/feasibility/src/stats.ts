import type { RequestLogEntry } from '@sss/collector-core';

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Request-level stats: success rate counts only 2xx; typed error codes are tallied, never hidden. */
export function latencyStats(log: RequestLogEntry[]) {
  const lat = log.map((l) => l.latencyMs).sort((a, b) => a - b);
  const ok = log.filter((l) => l.status !== null && l.status >= 200 && l.status < 300).length;
  const errors: Record<string, number> = {};
  for (const l of log) if (l.errorCode) errors[l.errorCode] = (errors[l.errorCode] ?? 0) + 1;
  const byEndpoint: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
  const groups = new Map<string, number[]>();
  for (const l of log) {
    const path = safePath(l.url);
    groups.set(path, [...(groups.get(path) ?? []), l.latencyMs]);
  }
  for (const [k, v] of groups) {
    const s = v.sort((a, b) => a - b);
    byEndpoint[k] = { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
  }
  return {
    total: log.length,
    success2xx: ok,
    successRate: log.length ? Math.round((ok / log.length) * 1000) / 1000 : null,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.at(-1) ?? null },
    errors,
    byEndpoint,
    retries: log.filter((l) => l.attempt > 1).length,
  };
}

function safePath(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return u;
  }
}
