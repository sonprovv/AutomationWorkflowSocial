# Runbook

Phase 1 covers a local, single-user deployment. If you don't know where to start, run `scripts/doctor` first.

| Symptom | Cause | Action |
|---|---|---|
| `Port 18966 is already in use` | Another program is using the port | Set `APP_PORT=18970` (or any free port) in `.env`, then start again |
| `Port 18968 (embedded PostgreSQL) is in use` | Another Postgres is running, or an old instance is still alive | Set `EMBEDDED_PG_PORT` in `.env` |
| Start says `INLINE mode` | Redis is not reachable | This is expected without Redis. Jobs and the scheduler tick run inside the API process (dev mode). Install Memurai or Redis for the separate worker and scheduler, then restart |
| `/health/ready` returns 503 with the `database` check failing | The database is down | Restart. If you use an external `DATABASE_URL`, check the server |
| `/health/ready` returns 503 with the `queue` check failing | Redis stopped | Start Memurai/Redis. Jobs already queued are kept in Redis |
| Job `FAILED` with `PROVIDER_UNAVAILABLE` or `TIMEOUT` | Provider outage or network problem (the job was already retried with backoff) | Retry later: `POST /jobs/:id/retry` or the **Retry** button |
| Job `FAILED` with `PERMISSION_DENIED`, `AUTH_REQUIRED` or `POLICY_BLOCKED` | Credentials, scope or policy (never retried automatically) | Fix the credential or configuration, then retry manually |
| `429 BUDGET_EXCEEDED` | The daily cap was reached (`*_DAILY_*` in `.env`) | Wait for 00:00 UTC, or raise the cap deliberately |
| `409 CONFLICT` on sync | A sync of the same account is already queued or running | Follow `details.jobId` |
| Job stuck in `RUNNING` after a crash | The process died mid-job | On the next start, orphaned jobs are marked `FAILED`/`ORPHANED`; with BullMQ, stalled jobs are re-delivered first. `GET /jobs/stats` flags jobs running longer than 1.5 × `JOB_TIMEOUT_SECONDS` as `stuck`. Retry with `POST /jobs/:id/retry` |
| Scheduled work should stop for a while | Maintenance, or the provider has a problem | `POST /api/v1/scheduler/pause` (running jobs finish, manual runs still work), then `POST /api/v1/scheduler/resume`. Single workflows: `PATCH /api/v1/workflows/:id {"enabled": false}` |
| A workflow did not run | Disabled, paused, nothing due, or an identical job still active | `GET /api/v1/workflows` shows `nextRunAt`, `lastStatus` and `lastResult.notes` for each |
| `BUDGET_EXCEEDED` although usage looks low | Active reservations of running jobs count toward the cap | Reservations are released when jobs finish, or expire after `JOB_TIMEOUT_SECONDS` + 5 min |
| Posts disappeared after a few days | WF14 deleted posts the provider stopped returning (after `CLEANUP_UNAVAILABLE_GRACE_HOURS`) | Expected (provider deletion rules). Set `CLEANUP_DELETE_UNAVAILABLE=false` to keep them hidden instead |
| Bluesky search page 2 returns `PERMISSION_DENIED` | Search pagination requires login | Set `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` (ADR-0005) |
| YouTube shows "not enabled" | It is not verified in Phase 0 yet | Add `YOUTUBE_API_KEY` and run the PoC (ADR-0007) |
| Garbled emoji or Vietnamese text | The database was not created with UTF-8 | The embedded DB is always UTF-8/ICU. An external DB must be created with `ENCODING 'UTF8'` |

## Logs
- **Service logs:** structured JSON (pino) in the start window. Authorization and API-key headers are redacted.
- **Job logs:** `GET /api/v1/jobs/:id` returns the job with its logs.
- **Provider calls:** `collection_runs` (also on the account page under **Sync history**) and `usage_logs`.

## Backup
Backup and restore are planned for Phase 8. Until then, to back up native mode: stop the app, then copy the `.data/` folder.
