# ADR-0010: Metrics refresh tiers and post availability

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 2

## Context
Master Plan §7.4 asks for metrics refresh on a schedule separate from profile sync, adaptive frequency by post age, and provider-verified handling of deleted or hidden posts ("never treat a network error as a deleted post"). The Bluesky Developer Guidelines require that content deleted by its author is not kept or redistributed.

## Decisions

### 1. A separate job: `post.metrics_refresh` (WF05/WF06)
- Payload `{accountId | null, projectId | null, trigger}`. `accountId = null` means every account with an active (`TRACKING`) project link.
- Queue `collection`. Idempotency key per account, or per `all:<projectId>`, so concurrent requests return `409`.
- Uses each adapter's batched `getPostMetrics` (Bluesky: 25 URIs per `getPosts` call; YouTube: 50 IDs per `videos.list`, 1 quota unit).
- At most `METRICS_REFRESH_MAX_POSTS` (default 500) posts per job, most overdue first.

### 2. Age tiers (by `sort_at`, i.e. published time)
| Post age | Refresh when the last metrics are older than |
|---|---|
| < 2 days | 1 hour |
| 2–7 days | 12 hours |
| 7–30 days | 24 hours |
| > 30 days | 7 days |

"Hot content every 30–60 min" needs viral scoring, which is policy-gated and arrives with WF07 (Phase 6). The scheduled trigger arrives with the Phase 4 workflow scheduler; Phase 2 exposes the job through the API.

### 3. Post availability
- If the provider **answers successfully** but leaves a requested post out, the post becomes `UNAVAILABLE` with `unavailable_reason = NOT_RETURNED_BY_PROVIDER` and `unavailable_at`. Both Bluesky `getPosts` and YouTube `videos.list` omit deleted, private or taken-down items this way.
- Errors (network, 5xx, 429, timeouts) never change availability. They fail or partially fail the job instead.
- UNAVAILABLE posts are hidden from `GET /posts` unless `includeUnavailable=true`.
- If a later sync returns the post again, it is set back to `AVAILABLE`.
- Deleting the stored data of UNAVAILABLE posts is the policy cleanup workflow (WF14, Phase 4). It follows the provider policy once the Product Owner approves it.

### 4. Snapshots stay policy-bound
Metric writes go through one helper (`writePostMetric`). Without `allowHistoricalSnapshots`, only the latest snapshot is kept, in the same transaction.

### 5. Provider index time
`posts.provider_indexed_at` stores Bluesky `indexedAt` (server time). `published_at` stays the author-supplied `createdAt`, which can be backdated. YouTube has no separate index time, so the column is `null` there.

## Consequences
- Each chunk of up to 100 posts commits in one transaction. A later failure keeps earlier chunks (`PARTIAL_SUCCESS`).
- Usage and collection runs are recorded per provider, as for syncs.
