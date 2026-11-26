# REST API (v1)

**Base URL:** `/api/v1`. In native mode it is served on `http://127.0.0.1:${APP_PORT}`.
**Machine-readable spec:** the OpenAPI document at `/api/docs/json`; the interactive UI is at `/api/docs`.

## Conventions

- **Binding and auth.** The API binds to localhost only. It has no authentication because it is single-user and local. A remote deployment must add TLS, auth and RBAC (Master Plan §11 and §13).
- **IDs** are UUIDs. Timestamps are ISO-8601 in UTC.
- **Pagination** is cursor-based: send `?limit=&cursor=` and receive `{ items, nextCursor }` back. Cursors are opaque.
- **Missing values** are `null` together with a `missing` reason map, for example `{"views":"NOT_SUPPORTED"}`. A missing value is never `0`.
- **Errors** use this envelope:
  ```json
  { "error": { "code": "CONFLICT", "message": "…", "details": { "jobId": "…" }, "requestId": "…" } }
  ```
  `x-request-id` is echoed back on every response.

### Status codes

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_INPUT` |
| 401 | `AUTH_REQUIRED`, `AUTH_EXPIRED` |
| 403 | `PERMISSION_DENIED`, `POLICY_BLOCKED` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 410 | `PRIVATE_OR_REMOVED` |
| 422 | `NOT_SUPPORTED` |
| 429 | `RATE_LIMITED`, `QUOTA_EXCEEDED`, `BUDGET_EXCEEDED` |
| 501 | Planned for a later phase |
| 502 | `PROVIDER_UNAVAILABLE`, `SCHEMA_CHANGED` |
| 503 | `SERVICE_UNAVAILABLE` |
| 504 | `TIMEOUT` |

### Long-running operations

These return `202`:

```json
{ "job_id": "…", "status": "QUEUED", "status_url": "/api/v1/jobs/…", "warnings": [], "job": { … } }
```

## Endpoints implemented in Phase 1

| Method | Route | Description |
|---|---|---|
| GET | `/health/live` | Liveness |
| GET | `/health/ready` | Database and queue readiness. Includes `queueDriver` (`bullmq` or `inline`) |
| GET / POST | `/projects` | List (`status`, `limit`, `cursor`) / create (`name`, `niche`, `platforms`, `languages`, `markets`, `timezone`, budgets, `settings`) |
| GET / PATCH / DELETE | `/projects/:id` | Detail / update (settings are merged) / delete (cascades to project links; shared accounts are kept) |
| GET | `/accounts` | List (`projectId`, `platform`, `limit`, `cursor`) with the latest metrics |
| POST | `/accounts` | Track an account (details below) |
| GET | `/accounts/:id` | Profile, latest metrics with provenance, linked projects, sync state, 10 most recent collection runs |
| POST | `/accounts/:id/sync` | Manual sync, returns 202. Returns 409 if a sync of this account is already active |
| POST | `/accounts/:id/refresh-metrics` | Phase 2. Refresh the metrics of this account's posts that are due (age tiers, see `docs/adr/0010-…`). Returns 202; 409 if a refresh of this account is already active |
| POST | `/metrics/refresh` | Phase 2. Same for every tracked account, optionally `{projectId}`. Paused tracking links are skipped |
| PATCH | `/accounts/:id/tracking` | `{projectId, trackingStatus?, priority?, approvalStatus?}` |
| GET | `/posts` | Filters: `accountId`, `projectId`, `platform`, `contentType`, `hashtag`, `q` (case-insensitive, Unicode-aware), `since`, `until`, `limit` (max 100), `cursor`, `includeUnavailable` (default `false`: posts the provider no longer returns are hidden). Sorted newest first. Each post has `providerIndexedAt`, `status`, `unavailable: {since, reason} \| null` and `provenance.lastMetricsAt` |
| GET | `/posts/:id` | Post with latest metrics and provenance |
| GET | `/posts/:id/metrics` | Metric snapshots allowed by policy. `historyAllowed: false` means only the latest snapshot is kept |
| GET | `/jobs` | Recent jobs (`status`, `projectId`, `limit`) |
| GET | `/jobs/:id` | Job plus logs (redacted) |
| POST | `/jobs/:id/cancel` | Cooperative cancel. Returns 409 if the job is already finished |
| POST | `/jobs/:id/retry` | Only for FAILED, CANCELLED or PARTIAL_SUCCESS jobs. Returns 202 with a new job linked by `retryOfId` |
| GET | `/providers` | All 10 providers: Phase 0 status, whether enabled or implemented, capabilities, effective policy, today's usage against the cap, last health check |
| POST | `/providers/:id/test` | Live credential and health check (counts toward the daily cap) |
| GET | `/usage` | Today's usage per implemented provider |

### Tracking an account (`POST /accounts`)

Request body: `{ input, platform?, projectId?, priority?, sync? }`.

- `input` is a profile URL, handle or ID. The platform is detected from it when possible; a bare `@handle` needs `platform`.
- The handle is resolved with one real provider call.
- The response is `201` if the account was created, `200` if it already existed.

Errors:
- `422 NOT_SUPPORTED`: the platform has no collector (for example TikTok, which is BLOCKED). `details` includes `providerStatus`.
- `403 POLICY_BLOCKED`: the provider is not enabled yet (for example YouTube before its Phase 0 verification).
- `429 BUDGET_EXCEEDED`: the daily cap is reached.

## Keywords and discovery (Phase 3)

| Method | Route | Description |
|---|---|---|
| GET | `/projects/:id/keywords` | Keywords (`status` filter) |
| POST | `/projects/:id/keywords` | `{keywords: [{text, language?, priority?}]}` → `201 {created, existing}`. Dedup by normalized text; adding a SUGGESTED keyword activates it |
| PATCH / DELETE | `/keywords/:id` | `{status?, priority?}` / delete |
| POST | `/projects/:id/keywords/expand` | WF01 rule mode: SUGGESTED variants (compact form, English singular/plural), capped by `max_keywords_per_run`. They are not searched until activated |
| POST | `/projects/:id/discover` | WF02, returns 202 + job. Body `{keywordIds?, platforms?}`. 400 without ACTIVE keywords; 409 while a discovery of the project is active |
| GET | `/projects/:id/candidates` | Review queue, best score first: `status`, `minScore`, `classification`, `limit`, `cursor` |
| GET | `/projects/:id/candidates/:candidateId` | One candidate with evidence |
| POST | `/projects/:id/candidates/approve` | `{candidateIds, sync=true}` → tracked in the project (relevance = score) + initial sync job. 409 if it would exceed `max_accounts` |
| POST | `/projects/:id/candidates/reject` | `{candidateIds}`. Rejecting an approved candidate pauses its tracking (data kept) |

The discovery job result has `coverage`: one entry per platform/keyword/operation with `status` `OK` (searched; 0 results is a real answer), `ERROR` (the call failed, with the typed code) or `SKIPPED` (not possible: no collector, provider disabled, capability missing, budget), so a failed source is never shown as "0 results".

## Workflows, scheduler and job monitor (Phase 4)

| Method | Route | Description |
|---|---|---|
| GET | `/workflows` | Scheduled workflows: `workflowKey`, `enabled`, `everyMinutes` or `cron` + `timezone`, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastResult`; plus `paused` |
| POST | `/workflows` | Create a schedule `{id, workflowKey, everyMinutes \| cron, timezone?, enabled?, config?}` |
| PATCH | `/workflows/:id` | `{enabled?, everyMinutes?, cron?, timezone?, config?}`. An invalid cron or timezone returns 400 |
| POST | `/workflows/:id/run` | Run now; returns `{status, jobIds, notes}`. The next scheduled run does not move |
| GET | `/scheduler` | `{paused, tickSeconds}` |
| POST | `/scheduler/pause`, `/scheduler/resume` | Stop or resume firing schedules |
| GET | `/jobs/stats` | Job monitor (`windowHours`, default 24): `byStatus`, `byName`, `active` (with `ageSeconds`, `stuck`), `deadLetter` (FAILED by error code, recent failures with retry URLs) |

## Dashboard and exports (Phase 5)

| Method | Route | Description |
|---|---|---|
| GET | `/dashboard` | Counts, posts per day (14 d), latest posts, most-liked posts in 7 d (raw provider count, not a score), coverage with usage, reserved and cost today, scheduler, jobs. Optional `projectId` |
| POST | `/exports` | `{format: xlsx\|csv\|json, projectId?, filters?}` (Content Explorer filters). Returns 202 + job + export |
| GET | `/exports` | Recent exports: status, row counts, `withheld` (per provider, with policy id and reason), file, expiry |
| GET | `/exports/:id` | One export |
| GET | `/exports/:id/download` | The file (`content-disposition: attachment`). 409 while not finished; 404 once expired |

## Analytics and AI (Phase 6)

All of these are policy-gated: posts whose provider policy denies derived metrics are reported under `blockedByPolicy`.

| Method | Route | Description |
|---|---|---|
| POST | `/projects/:id/analytics/viral` | WF07 viral-v1 scoring → 202 job |
| GET | `/analytics/viral?projectId=` | Scores (or `INSUFFICIENT_DATA`) with features, missing features, cohort and flags |
| POST | `/projects/:id/analytics/trends` | WF09 `{windowDays=7}` → 202 job |
| GET | `/analytics/trends?projectId=` | Latest snapshot: topics (signal, posts now/prev, accounts, confidence, reasons, supporting posts) and coverage |
| POST | `/projects/:id/analyze` | WF08 AI analysis of `{postIds?}` or the project's top posts → 202 job. Needs `ANTHROPIC_API_KEY` |
| POST | `/posts/:id/analyze` | AI analysis of one post → 202 job |
| GET | `/analytics/ai?projectId=` | Recent AI analyses for the project |
| GET | `/posts/:id/analysis` | AI analyses of one post |

## Routes registered for later phases (they return `501`)

| Method | Route | Phase |
|---|---|---|
| POST | `/posts/:id/analyze` | 6 |
| GET | `/analytics/viral` | 6 |
| GET | `/analytics/trends` | 6 |
| POST | `/exports` | 5 |
| GET | `/exports/:id/download` | 5 |
| POST | `/reports` | 7 |
