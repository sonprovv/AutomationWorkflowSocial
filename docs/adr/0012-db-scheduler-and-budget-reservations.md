# ADR-0012: DB-driven scheduler and atomic budget reservations

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 4
- **Supersedes:** the Phase 1 scheduler (BullMQ job scheduler per schedule) and the Phase 1 quota guard. It also changes one consequence of ADR-0008: inline mode now runs schedules.

## Context
Master Plan §7–9 asks for:
- scheduled workflows with a catch-up policy;
- no duplicate runs;
- recovery after a restart;
- pause;
- a budget guard that follows `authorize → reserve → execute → reconcile`, is atomic across workers, and never overspends concurrently.

The Product Owner's machine has no Redis yet. In Phase 1, schedules only ran in BullMQ mode.

## Decisions

### 1. One tick, state in PostgreSQL
- `SchedulerService.tick()` reads `schedules` (enabled, `next_run_at <= now`).
- Each due row is **claimed** with a conditional `UPDATE … WHERE next_run_at <= now`, which also sets the next slot. Only the runner whose update matched fires the workflow. Two schedulers, or a scheduler plus an API, can never fire the same slot.
- Fired work goes through `JobService.create` like manual runs. Idempotency keys therefore also stop overlaps with manual runs or still-running jobs; those cases are reported as `SKIPPED`.
- **Catch-up policy:** the next slot is computed from *now*. After downtime, each due schedule runs **once** and missed slots are not replayed.
- Cron schedules use `cron-parser` with the schedule's timezone (default `APP_TIMEZONE`). Interval schedules use `every_ms` (minimum 1 minute).
- Each run stores `last_status` (`ENQUEUED`, `NOTHING_DUE`, `SKIPPED` or `ERROR`) and `last_result` (job ids, notes).

### 2. Who runs the tick
- **BullMQ mode:** the `scheduler` process, every `SCHEDULER_TICK_SECONDS` (default 60). On start it removes the Phase 1 BullMQ job scheduler `wf13-provider-health`.
- **Inline dev mode (no Redis):** the API process, when `SCHEDULER_IN_PROCESS=true` (the default). This is why scheduled workflows now also work on a machine without Redis.

### 3. Built-in workflows
They are created on the first tick and can be edited with `/workflows`:

| Id | Workflow | Default | What it queues |
|---|---|---|---|
| `wf04-account-sync` | WF03/04 profile + new-post detection | every 5 min | `account.sync` for tracked, approved accounts of ACTIVE projects whose `next_sync_at` is due, at most `SCHEDULER_MAX_SYNCS_PER_TICK`; then `next_sync_at = now + settings.sync_interval_minutes` (default 120) |
| `wf05-metrics-refresh` | WF05/06 post monitoring | every 60 min | one `post.metrics_refresh` for all tracked accounts (the job applies the age tiers of ADR-0010) |
| `wf02-discovery` | WF02 discovery | every 60 min | `project.discover` for projects with `settings.discovery_every_hours > 0` (default 0 = off) whose last discovery is older than that |
| `wf13-provider-health` | WF13 health | `PROVIDER_HEALTH_EVERY_MINUTES` | `provider.health` |
| `wf14-policy-cleanup` | WF14 policy cleanup | cron `0 3 * * *` | `maintenance.cleanup` |

**Pause:** `POST /scheduler/pause` stores `app_settings.scheduler = {paused: true}`. Ticks then do nothing. Running jobs finish, and manual runs still work.

### 4. WF14 policy cleanup
- Posts that are `UNAVAILABLE` (not returned by the provider) are deleted after `CLEANUP_UNAVAILABLE_GRACE_HOURS` (default 72), together with their metrics. This follows the Bluesky Developer Guidelines on deletions. Set `CLEANUP_DELETE_UNAVAILABLE=false` to keep them hidden instead.
- Posts past a policy's `retention_days` are deleted. **If retention is unknown (`null`), nothing is deleted** and the result says the data is kept until the Product Owner approves a policy. Deny-by-default must not silently destroy data.
- The job also reports posts older than `refresh_days`, and purges old reservations (7 days), logs of finished jobs (30 days) and search hits (90 days).
- An audit-log row records the counts.

### 5. Budget guard: reservations
- `UsageGuard.meterFor` opens a transaction and takes `pg_advisory_xact_lock(hashtext('usage:<provider>:<unit>:<day>'))`.
- Inside it, it sums today's `usage_logs` and the active reservations (not settled, not expired), then inserts a reservation of `min(remaining, perOperationCap)`.
- If nothing remains, it raises `BUDGET_EXCEEDED`. Concurrent workers are serialized by the lock, so together they cannot reserve more than the cap.
- The adapter's `UsageMeter` is capped at the reservation, so a call that would go beyond it is refused before it is sent.
- `record()` writes the actual usage and settles the reservation in one transaction.
- Reservations expire after `JOB_TIMEOUT_SECONDS` + 5 min, so a crashed worker cannot block the budget.
- Monetary project budgets (`daily_budget_usd`, `monthly_budget_usd`) need a per-provider cost model. Every enabled provider costs $0, so the provider daily unit caps are the binding limits. A paid provider must add its cost model before it is enabled.

### 6. Job monitor
`GET /jobs/stats` returns:
- counts by status and by name over a window;
- active jobs with their age and a `stuck` flag (RUNNING longer than 1.5 × `JOB_TIMEOUT_SECONDS`);
- the **dead-letter view**: FAILED jobs grouped by error code, with retry links.

## Consequences
- Scheduling works without Redis. In BullMQ mode only the transport changes.
- Restart recovery works like this:
  - due schedules fire on the first tick after start (once);
  - orphaned jobs are reconciled (Phase 1 review fix);
  - stalled BullMQ jobs are re-delivered.
- Still to verify with a real Redis: the scheduler process in BullMQ mode, and the worker's failed-job and stall handling.
