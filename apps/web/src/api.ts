/** Thin typed client for the local REST API (same origin). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN_ERROR', e.message ?? `HTTP ${res.status}`, e.details);
  }
  return json as T;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Project {
  id: string;
  name: string;
  niche: string | null;
  platforms: string[];
  status: string;
  accountCount: number | null;
  timezone: string;
  createdAt: string;
}

export interface Metrics {
  followers?: number | null;
  following?: number | null;
  postsCount?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  missing: Record<string, string>;
  collectedAt: string;
  providerId: string;
  policyId: string;
}

export interface Account {
  id: string;
  platform: string;
  externalId: string;
  username: string | null;
  displayName: string | null;
  profileUrl: string;
  bio: string | null;
  avatarUrl: string | null;
  status: string;
  metrics: Metrics | null;
  provenance: { providerId: string; lastCollectedAt: string | null };
}

export interface AccountDetail extends Account {
  postCount: number;
  projects: { projectId: string; projectName: string; approvalStatus: string; trackingStatus: string; lastSyncAt: string | null; lastSyncStatus: string | null }[];
  sync: { backfillDone: boolean; watermark: string | null; lastSuccessAt: string | null } | null;
  recentRuns: { id: string; jobId: string | null; operation: string; status: string; requests: number; records: number; latencyMs: number | null; errorCode: string | null; warnings: string[]; startedAt: string }[];
}

export interface Post {
  id: string;
  platform: string;
  url: string;
  contentType: string;
  title: string | null;
  caption: string | null;
  hashtags: string[];
  language: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  account: { username: string | null; displayName: string | null };
  metrics: Metrics | null;
  provenance: { providerId: string; lastCollectedAt: string };
}

export interface Job {
  id: string;
  name: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: { code: string; message: string | null } | null;
  warnings: string[];
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
  resourceId: string | null;
}

export interface Provider {
  id: string;
  platform: string;
  status: string;
  enabled: boolean;
  implemented: boolean;
  credentialConfigured: boolean | null;
  usageToday: Record<string, number> | null;
  policy: { allowHistoricalSnapshots: boolean; allowDerivedMetrics: boolean; allowExport: boolean; retentionDays: number | null };
  lastHealth: { healthy?: boolean } | null;
  checkedAt: string | null;
}
