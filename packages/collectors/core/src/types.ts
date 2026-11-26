/**
 * Canonical collector types (Master Plan §5.1, §6.1).
 *
 * Rules enforced by these types:
 *  - External IDs are strings; stable ID chosen per platform is documented in each adapter.
 *  - `null` means missing / not supported / not provided — NEVER coerce to 0.
 *  - Every record carries provenance (provider, collectedAt, policyId, schemaVersion).
 *  - All timestamps are ISO-8601 UTC strings.
 */

export const PLATFORMS = [
  'youtube',
  'bluesky',
  'tiktok',
  'facebook',
  'instagram',
  'threads',
  'reddit',
  'x',
  'pinterest',
  'linkedin',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Capability verification state. */
export type CapabilityState =
  | 'SUPPORTED' // verified with a real call
  | 'PARTIAL' // works with documented limitations
  | 'AUTH_REQUIRED' // supported but needs credentials/app review we do not have
  | 'NOT_SUPPORTED' // provider does not offer it
  | 'BLOCKED' // possible only via means we will not use (ToS/legal) or no eligible access
  | 'UNKNOWN'; // not yet verified

export const CAPABILITY_KEYS = [
  'resolveAccount',
  'searchAccounts',
  'searchPosts',
  'getProfile',
  'listPosts',
  'getPostDetail',
  'getPostMetrics',
  'listComments',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type Capabilities = Record<CapabilityKey, CapabilityState>;

export type ProviderStatus = 'VERIFIED' | 'UNVERIFIED' | 'AUTH_REQUIRED' | 'BLOCKED' | 'NOT_SUPPORTED';

/** Deny-by-default data policy (Master Plan §9.2). `false` = not yet verified as allowed. */
export interface DataPolicy {
  policyId: string;
  allowHistoricalSnapshots: boolean;
  allowDerivedMetrics: boolean;
  allowMediaProcessing: boolean;
  allowExport: boolean;
  /** Max days stored data may be kept before refresh/delete. null = unknown -> treat as not allowed to persist long-term. */
  retentionDays: number | null;
  /** Max age before stored data must be refreshed (days). null = unknown. */
  refreshDays: number | null;
  notes: string[];
  sources: { url: string; checkedAt: string }[];
}

export interface CapabilityRecord {
  platform: Platform;
  provider: string;
  status: ProviderStatus;
  checkedAt: string;
  capabilities: Capabilities;
  policy: DataPolicy;
  quota: { unit: string; dailyLimit: number | null; notes: string[] };
  credentialsRequired: string[];
  limitations: string[];
}

export interface Provenance {
  providerId: string;
  collectedAt: string;
  policyId: string;
  schemaVersion: string;
  /** Endpoint/method that produced this record (for audit). */
  source: string;
}

export type MissingReason = 'NOT_PROVIDED' | 'HIDDEN_BY_OWNER' | 'NOT_SUPPORTED' | 'DISABLED';

export interface Account {
  platform: Platform;
  /** Stable external ID (e.g. YouTube channel ID "UC…", Bluesky DID). */
  externalId: string;
  username: string | null;
  displayName: string | null;
  profileUrl: string;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: string | null;
  metrics: AccountMetrics | null;
  provenance: Provenance;
}

export interface AccountMetrics {
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  /** Platform-specific extra counters (e.g. YouTube total channel views). */
  extra: Record<string, number | null>;
  missing: Partial<Record<'followers' | 'following' | 'postsCount', MissingReason>>;
  collectedAt: string;
}

export type ContentType = 'video' | 'short' | 'live' | 'image' | 'text' | 'link' | 'mixed' | 'unknown';

export interface Post {
  platform: Platform;
  externalId: string;
  /** External ID of the author account. */
  accountExternalId: string;
  url: string;
  contentType: ContentType;
  title: string | null;
  caption: string | null;
  hashtags: string[];
  language: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  /** Provider-side index/ingest time when the platform exposes one (Bluesky indexedAt). publishedAt may be author-supplied. */
  indexedAt?: string | null;
  metrics: PostMetrics | null;
  provenance: Provenance;
}

export interface PostMetrics {
  postExternalId: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  /** Platform-specific extra counters (e.g. Bluesky quoteCount). */
  extra: Record<string, number | null>;
  missing: Partial<Record<'views' | 'likes' | 'comments' | 'shares' | 'saves', MissingReason>>;
  collectedAt: string;
}

export interface Comment {
  platform: Platform;
  externalId: string;
  postExternalId: string;
  authorExternalId: string | null;
  text: string | null;
  publishedAt: string | null;
  likes: number | null;
  provenance: Provenance;
}

export interface Usage {
  requests: number;
  records: number;
  /** Provider-native quota units (e.g. YouTube quota units). */
  quotaUnits?: number;
  costUsd?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  collectedAt: string;
  usage: Usage;
  warnings: string[];
}

export interface SearchInput {
  query: string;
  limit?: number;
  cursor?: string | null;
  /** BCP-47 language hint (if supported). */
  language?: string;
  /** ISO 3166-1 alpha-2 market/region hint (if supported). */
  region?: string;
  since?: string;
  until?: string;
  signal?: AbortSignal;
}

export interface ResolveAccountInput {
  /** Profile URL, handle/username, or platform ID. */
  input: string;
  signal?: AbortSignal;
}

export interface ListPostsInput {
  accountExternalId: string;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export interface ListCommentsInput {
  postExternalId: string;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export type CredentialState =
  | 'VALID'
  | 'NOT_REQUIRED'
  | 'MISSING'
  | 'INVALID'
  | 'EXPIRED'
  | 'INSUFFICIENT_SCOPE'
  | 'QUOTA_EXCEEDED'
  | 'API_DISABLED'
  | 'UNKNOWN';

export interface CredentialStatus {
  state: CredentialState;
  message: string;
  checkedAt: string;
}

export interface HealthStatus {
  healthy: boolean;
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

/** Adapter contract (Master Plan §5.1). Unsupported methods MUST throw CollectorError('NOT_SUPPORTED'). */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly providerId: string;
  getCapabilities(): Promise<Capabilities>;
  validateCredentials(): Promise<CredentialStatus>;
  healthCheck(): Promise<HealthStatus>;
  resolveAccount(input: ResolveAccountInput): Promise<Account>;
  searchAccounts(input: SearchInput): Promise<Page<Account>>;
  searchPosts(input: SearchInput): Promise<Page<Post>>;
  getProfile(accountExternalId: string, signal?: AbortSignal): Promise<Account>;
  listPosts(input: ListPostsInput): Promise<Page<Post>>;
  getPostDetail(postExternalId: string, signal?: AbortSignal): Promise<Post>;
  getPostMetrics(postExternalIds: string[], signal?: AbortSignal): Promise<PostMetrics[]>;
  listComments(input: ListCommentsInput): Promise<Page<Comment>>;
}
