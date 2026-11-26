# PROGRESS — Social Spy Automation

- **Specification:** [`SOCIAL_SPY_AUTOMATION_PLAN.md`](SOCIAL_SPY_AUTOMATION_PLAN.md)
- **Decisions:** [`docs/adr/`](docs/adr/)
- **Repository:** github.com/sonprovv/AutomationWorkflowSocial (branch `main`)

> ▶ **Resumed 2026-11-26 15:23 UTC.** Open items are in [`NEXT_STEPS.md`](NEXT_STEPS.md).

**Status legend:** ✅ done, with evidence · 🟡 in progress, or blocked waiting on input · ⬜ not started · ⚠ written but not yet run or verified

| Phase | Scope | Status |
|---|---|---|
| 0 | Data Source Feasibility | 🟡 Code, tests and docs are done. **The gate is still open:** it needs `YOUTUBE_API_KEY` to verify a second source. The Product Owner chose to continue in the meantime (ADR-0007) |
| 1 | Monorepo, runtime, DB, REST, queue, provider SDK, vertical slice | 🟡 **Core done and tested with real data.** Open: the BullMQ path with a real Redis, Docker mode, and macOS (§Phase 1 open items) |
| 2 | YouTube/Bluesky live adapters at production level; TikTok/Meta where possible | ⬜ |
| 3–9 | See Master Plan §16 | ⬜ |

---

## Phase 1 — Platform skeleton (started 2026-11-26)

### Sprint items (Master Plan §16.1)
| ID | Item | Status | Evidence |
|---|---|---|---|
| P1-01 | Monorepo, Compose, configurable port, `.env.example` | ✅ / ⚠ | npm workspaces: `apps/*`, `packages/*`, `tools/*`. `APP_PORT` defaults to 18966 and can be changed in config. `.env.example` is complete. The native `start.bat`/`start.command`, `stop.*` and `scripts/doctor.*` were **run on Windows 11**. ⚠ `docker-compose.yml` is written but **not run** (this machine has no Docker). ⚠ macOS has not been tested |
| P1-02 | Migrations for projects, accounts, posts, providers, jobs and policies | ✅ | Prisma 7 with 17 tables, the init migration, and a partial unique index for active-job dedup. Applied on every test run against real PostgreSQL 17 (embedded). See `docs/DATABASE.md` |
| P1-03 | Adapter interfaces, canonical types, typed errors, fixtures | ✅ | Done in Phase 0 (ADR-0003). Added `collectors/registry`. Fixtures are labelled SYNTHETIC or CAPTURED |
| P1-04 | Queue, worker, idempotency, scheduler, health endpoints | ✅ / ⚠ | `@sss/queue` provides the BullMQ dispatcher plus an inline dispatcher for dev and test. The worker and scheduler apps are written. Idempotency: a DB partial unique index, with 409 on conflict. `/health/live` and `/health/ready` work. Retry, backoff, cancel and partial success are **tested through the inline path**. ⚠ The BullMQ path has its test written (`tests/integration/bullmq.test.ts`) but it is **skipped** until Redis or Memurai is installed |
| P1-05 | API endpoints: create project, track account, sync, job status | ✅ | Fastify `/api/v1` with OpenAPI at `/api/docs` (see `docs/API_SPEC.md`). The routes planned for later phases return 501 and name their phase |
| P1-06 | Vertical slice: account URL → real data → DB → UI/API | ✅ | `npm run slice` against real Bluesky passed all checks, with evidence in `docs/phase1/vertical-slice/2026-11-26T09-45-51-361Z.json`. Native start ran on Windows: an account was tracked over HTTP, real posts were served by the API and the UI, and the data was still there after stop/start |

### Test evidence (2026-11-26, Windows 11, Node 22.16.0)
- `npm run typecheck`: clean. Covers the server packages and the web app.
- `npm test`: **94 passed, 1 skipped.** The skipped test is the BullMQ test, which needs Redis.
  - **unit (74):** collectors, feasibility tooling.
  - **integration (15)** on real embedded PostgreSQL:
    - the API → services → processor → real Bluesky adapter flow, run against a local fake AppView;
    - project CRUD, cascades and audit log;
    - account tracking, initial sync and incremental re-sync with no duplicates;
    - the policy that keeps only the latest metric snapshot;
    - keyset pagination;
    - typed NOT_FOUND marking the account (network errors never do);
    - retry with backoff, then FAILED;
    - retry endpoint, PARTIAL_SUCCESS and checkpoint atomicity;
    - 409 dedup and cooperative cancel;
    - blocked and disabled providers (422 / 403);
    - error envelope and 501 planned routes;
    - Unicode (emoji, Vietnamese, CJK) storage and Vietnamese case-insensitive search;
    - DB constraints and seeding from capability records;
    - daily quota guard (429 with no request sent);
    - scheduler-triggered runs and shared dedup keys.
- `npm run slice -- https://bsky.app/profile/bsky.app` (**real data**):

  | Step | Result |
  |---|---|
  | Track | 201, 609 ms |
  | Initial sync | 20 posts, 3.2 s |
  | Re-sync | SUCCEEDED, 0 duplicates |
  | Metric snapshots | 1 per post |
  | `views` | `null` (Bluesky has no views) |

- Native runtime on Windows:
  - `start` brought up embedded PG → migrations → API + UI at http://127.0.0.1:18966.
  - Tracked `@atproto.com` over HTTP and received real posts with like counts.
  - `stop` shut down gracefully (PG stopped).
  - On restart the data was still there.

### Bugs found by real-data runs (fixed, with regression tests)
| Bug | Fix |
|---|---|
| On Windows, embedded PostgreSQL defaulted to **WIN1252**, so emoji in a profile caused HTTP 500 | `initdb --encoding=UTF8` |
| The C locale cannot case-fold Vietnamese (`'Tiếng' ILIKE '%TIẾNG%'` = false) | ICU `und` locale. Docker uses the same initdb flags |

### Bugs found by the Phase 1 code review (fixed; regression tests in `tests/integration/review-fixes.test.ts`)
| Bug | Fix |
|---|---|
| A job that hit `JOB_TIMEOUT_SECONDS` was recorded as CANCELLED ("Cancelled") | Abort reason is checked: user cancel → CANCELLED, timeout → FAILED/`TIMEOUT`, shutdown → CANCELLED/`ABORTED` |
| A scheduled execution re-delivered by BullMQ after a stall hit the dedup conflict and was skipped, leaving its DB row RUNNING forever | The DB row stores the BullMQ job id in `correlationId`; a re-delivery resumes that row |
| A BullMQ job that failed for good without the processor recording it (stalled too often, lock lost) left the DB row RUNNING/QUEUED | Worker `failed` handler makes the row terminal (`STALLED`/`FAILED`); no-op if already finished |
| After a restart, jobs whose execution was lost stayed active forever (inline mode always; BullMQ if Redis data was lost) | Startup reconciliation marks them FAILED/`ORPHANED` (API in inline mode, worker in BullMQ mode; jobs younger than 2 min skipped) |
| `usage_logs.actual_cost` repeated the operation cost on every unit row (2–3× when summed) | Cost booked on one row only |
| Incremental sync stopped on page 1 when a pinned old post was at the top, missing newer posts on later pages | "Caught up" now uses the oldest post of the page; a warning is added when the 10-page cap is hit first |
| On Windows the 15 s stop fallback killed only the tsx wrapper, leaving the real service process running | `taskkill /T /F` on the process tree |

Reviewed with no change needed: keyset pagination (`sortAt desc, id desc` with a matching cursor predicate), the API error-handler status mapping, and the retry path (`markRetrying` → QUEUED, re-delivery accepted by `markRunning`).

### Decisions (ADR)
- **ADR-0007:** continue with Phase 1 while the Phase 0 gate waits for the YouTube key.
- **ADR-0008:** native local runtime by default.
  - Embedded PG, with Redis or Memurai optional; inline mode is dev-only.
  - Docker stays optional. Garnet was evaluated and found **not compatible with BullMQ**.
- **ADR-0009:**
  - job state lives in PostgreSQL;
  - dedup, retry and cancel semantics;
  - transactional checkpoints;
  - policy-aware metric storage;
  - layering, pagination, API conventions.

### Technical limitations and proposed solutions
| Limitation | Proposal |
|---|---|
| This machine has no Redis, so there is no worker or scheduler (inline mode) | User installs `winget install Memurai.MemuraiDeveloper`. The BullMQ test then runs automatically |
| No Docker, so Compose cannot be verified | Optional. Verify on a machine with Docker Desktop, or keep native mode |
| Phase 1 quota guard is a daily cap; concurrent workers can overshoot by up to one operation | Atomic reservation engine in Phase 4 (§9.1) |
| The UI is minimal (no design system or charts) and has no Playwright tests | Phase 5 (dashboard, Content Explorer, Playwright) |
| The UI build is served correctly but has not been checked visually in a browser by the agent | The user opens http://127.0.0.1:18966 after `start.bat` |

### Phase 1 open items
1. ⚠ Run `tests/integration/bullmq.test.ts` with Redis or Memurai (needs the user to install one).
2. ⚠ Run `start.bat --docker` on a machine with Docker. Optional.
3. ⚠ Test `start.command` on macOS.

---

## Phase 0 — Data Source Feasibility (started 2026-11-26)

### Sprint items
| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-01 | Repo, ADR, capability matrix | ✅ | ADR-0001…0006; `docs/feasibility/capabilities/*.json` (10 platforms, schema-tested) |
| P0-02 | YouTube PoC CLI with the user's API key, plus policy check | 🟡 | Adapter and contract tests are done. Live checks of invalid and missing keys pass. **Waiting for `YOUTUBE_API_KEY`** to do the 3 live runs |
| P0-03 | Bluesky PoC CLI against public endpoints | ✅ | `docs/feasibility/runs/bluesky/` + `SUMMARY.md` |
| P0-04 | TikTok/Meta legitimate sources, or a report of what is blocked | ✅ | tiktok.md (BLOCKED / LEGAL_RISK); facebook, instagram, threads (AUTH_REQUIRED); ADR-0006 |
| P0-05 | Results, cost, fields, samples, sources and dates | ✅ | `runs/`, `samples/`, cost estimate in `docs/feasibility/README.md` §3 |

### Evidence
- Bluesky PoC runs (3 runs, 08:27 to 15:23 UTC): 24 PASS / 3 FAIL / 1 SKIP per run.
  - The 3 FAILs are a real platform limit: unauthenticated search pagination returns 403 (ADR-0005).
- YouTube: `AUTH_REQUIRED` (no key yet).

### Open items blocking the Phase 0 gate
1. 🟡 **User:** add `YOUTUBE_API_KEY` to `.env`. Then run `npm run poc -- youtube` three times and `npm run poc:summary`.
2. 🟡 **Product Owner:** the decisions in `docs/feasibility/README.md` §5 (Bluesky policy proposal, TikTok option, Meta App Review, paid sources).

---

## Log (UTC)
- 2026-11-26 08:11 — Phase 0 start.
- 2026-11-26 08:27 / 08:34 — Bluesky PoC runs 1 and 2. YouTube credential checks only.
- 2026-11-26 ~08:45 — Phase 0 docs, capability records, ADR-0001…0006. Pushed to GitHub.
- 2026-11-26 09:13 — Product Owner: continue; keys will be added at the end. Phase 1 starts.
- 2026-11-26 09:15–09:25 — Environment check: no Docker or WSL. Garnet rejected (BullMQ incompatible). Embedded PG chosen; Product Owner prefers lightweight.
- 2026-11-26 09:30–09:40 — Prisma schema and migrations, queue, services, API, worker, scheduler. 82 tests passing.
- 2026-11-26 09:45 — Real-data vertical slice. Found and fixed the UTF-8/ICU bugs.
- 2026-11-26 09:50 — Native start/stop verified on Windows. Minimal web UI. Docker Compose written (not run).
- 2026-11-26 ~10:00 — Phase 1 docs (ARCHITECTURE, API_SPEC, DATABASE, DEPLOYMENT, RUNBOOK, COLLECTOR_SPEC, ADR-0007…0009).
- 2026-11-26 10:00 — **Paused** at the Product Owner's request. The Phase 1 code review was interrupted and the scheduled Bluesky run 3 was cancelled. Resume from [`NEXT_STEPS.md`](NEXT_STEPS.md).
- 2026-11-26 15:23 — Resumed. Bluesky PoC run 3: same result as runs 1–2 (24/3/1).
- 2026-11-26 ~15:30 — Phase 1 code review done: 7 bugs fixed with regression tests (see above). `npm test`: 94 passed, 1 skipped. Native start/stop re-checked on Windows.
