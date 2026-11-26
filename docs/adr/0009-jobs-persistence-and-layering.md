# ADR-0009: Phase 1 jobs, persistence and code layers

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 1

## Decisions

### 1. Layering (Master Plan §0)
Business logic lives in `packages/services`. These packages are thin adapters over it:
- `apps/api` (HTTP)
- `apps/worker` (BullMQ)
- `apps/scheduler`
- `tools/local` (CLI)

MCP is in Phase 7 and will wrap the same services. Code only gets provider adapters through `packages/collectors/registry`, so business logic never imports a platform package.

### 2. Prisma 7 with the `pg` driver adapter
- Generated client code goes to `packages/database/src/generated` (git-ignored; `postinstall` generates it).
- Migrations are committed.
- `npm run db:migrate:new -- <name>` creates migrations against a throwaway embedded PostgreSQL.
- One constraint Prisma cannot express is a hand-written SQL migration: a partial unique index allowing only one QUEUED or RUNNING job per idempotency key.

### 3. Job state
- **PostgreSQL is the source of truth** for job status, progress, errors, warnings and logs.
- BullMQ (or the inline dispatcher) only transports jobs and handles retry and backoff.
- The BullMQ job id equals the database job id.

**Dedup.** Manual, track-triggered and scheduled syncs of the same account share one idempotency key. A second request while a job is active returns `409 CONFLICT` with `details.jobId`. A scheduler-triggered run in that situation is skipped.

**Retry policy.**
- Only `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` and `TIMEOUT` are retried, with exponential backoff plus jitter.
- Every other error fails at once (BullMQ `UnrecoverableError`).
- Max attempts = `MAX_RETRIES + 1`.

**Cancellation is cooperative.** The cancel endpoint sets `cancel_requested`. Waiting jobs are removed from the queue. A running sync stops at the next page boundary and keeps the pages it has already committed.

### 4. Sync checkpointing
- Each page's posts, metrics and the `sync_cursors` checkpoint are committed in **one transaction**, so the checkpoint can never move past unsaved data.
- An incremental sync re-reads a **24-hour overlap** before the watermark.
- If an error happens after some data is committed, the result is `PARTIAL_SUCCESS`.
- An account's status changes to `NOT_FOUND` or `PRIVATE_OR_REMOVED` only on a typed provider error, never on a network error.

### 5. Policy-aware metric storage
If the provider policy does not allow historical snapshots (the deny-by-default for all providers today), only the **latest** snapshot per post or account is kept. Older rows are deleted in the same transaction. The `GET /posts/:id/metrics` endpoint reports `historyAllowed`.

### 6. Pagination
- Keyset pagination over `(sort_at DESC, id DESC)`, where `sort_at = published_at`, falling back to `first_seen_at`.
- Cursors are opaque base64url tokens.

### 7. API surface
- Routes are under `/api/v1`, documented with OpenAPI at `/api/docs`.
- Errors use a standard envelope `{error:{code,message,details,requestId}}`.
- Long-running operations return `202 {job_id,status,status_url,warnings}`.
- Routes planned for later phases are already registered and return `501 NOT_SUPPORTED` naming their phase, so the full §11 surface is visible and none of it is silently dropped.

### 8. Quota guard (interim)
- A daily cap per provider, based on UTC days, from `usage_logs`. Each operation gets a `UsageMeter` capped at the remaining allowance.
- Concurrent workers can overshoot by at most one operation's cap.
- The atomic reservation engine (authorize → reserve → execute → reconcile) replaces this in Phase 4.

## Consequences
- Every new job type must:
  1. add a payload schema to `@sss/queue`,
  2. handle it in `createJobProcessor`,
  3. define its idempotency key.
- Raw provider responses are not stored. The `raw_responses` table is deferred until a phase needs it, subject to policy.
