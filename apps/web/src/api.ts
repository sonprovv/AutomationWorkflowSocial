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

/** Remote deployments require API_TOKEN; the UI asks once and keeps it in this browser only (sessionStorage). */
function token(): string | null {
  try {
    return sessionStorage.getItem('sss-api-token');
  } catch {
    return null;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const t = token();
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && !retried) {
    const entered = window.prompt('This server requires an API token (API_TOKEN):');
    if (entered) {
      try {
        sessionStorage.setItem('sss-api-token', entered.trim());
      } catch {
        /* storage unavailable */
      }
      return api<T>(path, init, true);
    }
  }
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
  languages: string[];
  markets: string[];
  status: string;
  accountCount: number | null;
  timezone: string;
  settings: Record<string, unknown>;
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

export interface PostFull extends Post {
  externalId: string;
  accountId: string;
  providerIndexedAt: string | null;
  status: string;
  unavailable: { since: string | null; reason: string | null } | null;
}

export interface Keyword {
  id: string;
  text: string;
  normalizedText: string;
  language: string | null;
  origin: string;
  status: string;
  priority: number;
  parentId: string | null;
}

export interface Candidate {
  id: string;
  accountId: string;
  account: { platform: string; externalId: string; username: string | null; displayName: string | null; profileUrl: string; bio: string | null };
  score: number;
  classification: string;
  approvalStatus: string;
  evidence: {
    scoreVersion?: string;
    confidence?: string;
    reasons?: string[];
    matchedKeywords?: string[];
    samplePosts?: { url: string; text: string | null; publishedAt: string | null; likes: number | null; keyword: string }[];
    profile?: { url: string; followers: number | null; postsCount: number | null; collectedAt: string };
  };
  decidedAt: string | null;
  decidedBy: string | null;
  lastSeenAt: string;
}

export interface CoverageEntry {
  platform: string;
  providerId: string | null;
  keyword: string | null;
  operation: string;
  status: string;
  results: number | null;
  reason: string | null;
  warnings: string[];
}

export interface Workflow {
  id: string;
  workflowKey: string;
  description: string | null;
  enabled: boolean;
  everyMinutes: number | null;
  cron: string | null;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastResult: { jobIds?: string[]; notes?: string[] } | null;
}

export interface ExportRow {
  id: string;
  format: string;
  status: string;
  filters: Record<string, unknown>;
  rowCounts: Record<string, number>;
  withheld: { providerId: string; posts: number; accounts: number; reason: string; policyId: string }[];
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
  downloadUrl: string | null;
}

export interface JobStats {
  byStatus: Record<string, number>;
  byName: Record<string, Record<string, number>>;
  active: { id: string; name: string; status: string; progress: number; ageSeconds: number; stuck: boolean }[];
  deadLetter: { byErrorCode: Record<string, number>; recent: { id: string; name: string; errorCode: string | null; errorMessage: string | null; finishedAt: string | null }[] };
}

export interface Dashboard {
  counts: Record<string, number>;
  postsPerDay: { day: string; posts: number }[];
  latestPosts: PostFull[];
  topPostsByLikes7d: { note: string; items: PostFull[] };
  coverage: { providerId: string; platform: string; status: string; enabled: boolean; healthy: boolean | null; checkedAt: string | null; usageToday: Record<string, number>; reservedToday: Record<string, number>; costTodayUsd: number }[];
  scheduler: { paused: boolean; next: { id: string; workflowKey: string; nextRunAt: string | null; lastStatus: string | null }[] };
  jobs: { byStatus: Record<string, number>; active: number; stuck: number; failed24h: number };
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
