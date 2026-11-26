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
| 2 | YouTube/Bluesky live adapters at production level; TikTok/Meta where possible | 🟡 **Bluesky done with real data** (contract tests, real-data sync of 3 accounts, metrics refresh, usage + provenance). Open: YouTube live verification (needs the key); TikTok/Meta wait on Product Owner decisions (§Phase 2) |
| 3 | Project, keyword, discovery, review, tracking, incremental sync | ✅ **Gate passed with real Bluesky data** (seed keyword → candidates → approved account → posts). YouTube discovery waits for the key |
| 4 | Scheduled workflows, reliability, policy & budget guards, job monitor | ✅ **Done and tested** (also in a real native run without Redis). Open: BullMQ-mode verification of the scheduler process and worker stall handling (needs Redis) |
| 5 | Web dashboard, content explorer, exports | ✅ **Gate passed with real data**: UI rendered in a real browser, real Excel file validated by openpyxl. Bluesky rows are withheld from exports until the Product Owner approves the policy |
| 6 | Allowed analytics, AI analysis, trend engine | ✅ **Done, tested on real data** (with a test policy in a throwaway DB). In the product it stays blocked until the Product Owner approves the policies; AI needs `ANTHROPIC_API_KEY` |
| 7 | MCP, Telegram/email, reports, n8n templates | ✅ **Gate passed with real data** (agent tool call → job → export/report). Real Telegram/email delivery needs the user's channel settings; n8n templates written and unit-tested, not run inside n8n |
| 8 | Security, scale, backup, observability, deployment | ✅ **Gate passed**: restore test on the real local DB, security check 7/7, load report (50k synthetic posts). Not run: Docker, macOS, cloud |
| 9 | Visual workflow editor, additional platforms, App/Ad Spy | 🟡 **P9-01 engine, P9-02 visual editor and P9-03 App Spy done** (App Store VERIFIED with real data; Google Play BLOCKED). P9-04 Ad Spy desk research done. Next: close-out |

---

## Phase 9 — Post-MVP: workflow builder, App/Ad Spy (started 2026-11-27)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P9-01 | Versioned workflow DAG (`workflow_defs`/`workflow_versions`/`workflow_runs`), validation (whitelist, acyclic, reachable, bounded waits, if-branches), executor over the existing guarded jobs, `/workflow-defs` API | ✅ | `tests/integration/workflow-builder.test.ts`; ADR-0017 |
| P9-02 | Visual editor (`#/builder`): SVG canvas (move, drag-to-connect, select/delete, true/false if-edges), forms built from each node type's JSON Schema, Validate / Save version / Run, version history (restore = save again), run status on each node, run cancel. API additions: `PATCH` name/project/status, `GET /versions/:version` | ✅ | `apps/web/test/graph-edit.test.ts` (6) + 1 new API test; checked in headless Edge over CDP on the real app: add node → connect → move → edge into the start node refused → validate → saved v2, confirmed via the API. Dependency-free SVG instead of React Flow (ADR-0017) |
| P9-03 | App Spy: Apple iTunes Search/Lookup feasibility (2 live PoC runs, 8 PASS / 2 PARTIAL / 0 FAIL each); Google Play BLOCKED (official docs). Built: `@sss/collector-appstore` (paced client, SSRF-safe page fetch, link extraction), tables `apps` / `project_apps` / `app_social_links`, `/apps` API, App Spy UI. App → developer website → social profile links with evidence, never by name | ✅ | `docs/feasibility/apple-app-store.md`, `google-play-apps.md`, `app-stores/*.json`; tests: `packages/collectors/appstore/test` (11), `tests/integration/app-spy.test.ts` (2); real-data check in the local app: Goodnotes tracked from its App Store link, website → 5 proposed profiles, all HIGH; ADR-0018 |
| P9-04 | Ad Spy desk research: Meta Ad Library API AUTH_REQUIRED (EU and political ads only; spend as ranges, political only); Google Ads Transparency Center BLOCKED (no API; BigQuery dataset reported, unverified); TikTok Commercial Content API LEGAL_RISK (EU only; research-purpose terms). Records only, no adapter; spend, revenue and ROAS are never inferred | ✅ | `docs/feasibility/ad-spy.md`, `ad-sources/*.json`; `tools/feasibility/test/ad-sources.test.ts` (5) |

Notes:
- **App Spy data policy waits for the Product Owner**: history and export stay off until `policyProposal.status` in `docs/feasibility/app-stores/apple.json` is APPROVED.
- **No project in the local app database yet,** so **Run now** has not been clicked in the real app. Execution is covered by the integration tests. The app has an example workflow, "Weekly market scan (example)": attach a project to it to run it.
- **After `npm run build:web`, restart the app**, because static files are registered at startup (RUNBOOK).

## Phase 8 — Security, backup, observability, scale (started 2026-11-26 17:30 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P8-01 | Encrypted logical backups (AES-256-GCM, manifest + checksums), WF15 daily, rotation; verified restore into a fresh DB; `npm run backup -- verify` restore test | ✅ | `tests/integration/security-ops.test.ts`; real restore test on the local app DB: 29 tables / 107 rows, all checksums OK |
| P8-02 | Security headers + CSP; loopback by default; `API_TOKEN` required for remote exposure (constant-time); UI/MCP token support | ✅ | tests |
| P8-03 | `npm run security:check`: secret scan, ignore rules, .env.example, defaults, npm audit | ✅ | `docs/phase8/security-2026-11-26T17-36-42-634Z.json`: 7/7 PASS (after upgrading nodemailer 8.0.11 → 10.3.1, a high advisory) |
| P8-04 | `GET /api/v1/metrics` (Prometheus) | ✅ | tests; real app |
| P8-05 | Load report: 50k SYNTHETIC posts, concurrent API, deep pagination, 50k-row export | ✅ | `docs/phase8/load-2026-11-26T17-41-10-024Z.json`; fixed: export bind-parameter limit (keyset batches), dashboard p50 800 ms → ~7 ms (15 s cache) |
| P8-06 | Cloud/24-7 deployment guide (HTTPS proxy, token, managed PG/Redis, backups, monitoring) | ⚠ | `docs/DEPLOYMENT.md` §3 — written, not run in a cloud |

Tests: `npm test` **176 passed, 1 skipped**.

## Phase 7 — MCP, notifications, reports (started 2026-11-26 17:15 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P7-01 | Daily/weekly reports (WF11/12): new accounts/posts, standout posts, topics, failed sources (→ PARTIAL_SUCCESS), cost, actions, links; Excel attached; URLs only where export is allowed | ✅ | `tests/integration/mcp-reports.test.ts` |
| P7-02 | Notifications: Telegram, email (SMTP), HMAC-signed webhook; dedup; bounded retries; SKIPPED when unconfigured | ✅ (fake endpoints) / 🟡 live | tests; live needs `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, SMTP or `WEBHOOK_URL` |
| P7-03 | MCP server `apps/mcp` (stdio) over the REST API: 21 read-only tools, 10 opt-in mutation tools; no quota/policy/credential tools | ✅ | real MCP client in tests; `docs/MCP.md` |
| P7-04 | n8n templates (scheduled report, signed-webhook receiver) | ⚠ | structure + signature code unit-tested; not run inside n8n |
| P7-05 | Reports page (history, text, Excel, notification log, test send) | ✅ | build + typecheck |
| P7-06 | Gate with real data | ✅ | `npm run phase7:mcp` → `docs/phase7/2026-11-26T17-24-47-160Z.json`: 6/6 PASS |

Tests: `npm test` **171 passed, 1 skipped**.

## Phase 6 — Analytics, AI, trends (started 2026-11-26 16:50 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P6-01 | Policy gate for all derived analytics (`allowDerivedMetrics`); blocked data counted, never scored as 0, never sent to AI | ✅ | `tests/integration/analytics-ai.test.ts`; real run step A |
| P6-02 | WF07 viral-v1: cohorts, velocity/acceleration (history), engagement, baseline, relevance; renormalized weights; INSUFFICIENT_DATA; NEGATIVE_DELTA flag | ✅ | `packages/services/test/analytics.test.ts`; real run: 33/33 real posts scored |
| P6-03 | WF09 trends-v1: equal windows, accounts diversity, confidence, "collected sample only" coverage | ✅ | tests; real run |
| P6-04 | WF08 AI analysis via official SDK: structured output, untrusted-input isolation, dedup by input hash, per-day/project caps, project USD budget, refusal handling, token+cost usage | ✅ (fake API) / 🟡 live | tests against a local fake Messages API; live run needs `ANTHROPIC_API_KEY` |
| P6-05 | Scheduler WF07 (hourly), WF09 (6 h), WF08 (07:00, opt-in); API; Insights UI; Viral/Trends/AI_Analysis export sheets | ✅ | tests; Insights screenshot (private) |
| P6-06 | Real-data run | ✅ | `npm run phase6:analytics` → `docs/phase6/2026-11-26T17-12-58-662Z.json`: 6/6 PASS |

**Finding:** with history denied by policy (no velocity), viral labels skew high on real data (4 breakout / 2 viral / 6 trending of 33). The thresholds must be recalibrated once history is allowed (ADR-0014).

Tests: `npm test` **166 passed, 1 skipped**.

## Phase 5 — Dashboard, Content Explorer, exports (started 2026-11-26 16:20 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P5-01 | Exports xlsx/csv/json (WF17): Summary, Accounts, Posts, Keywords, Collection_Log, Usage, Data_Dictionary; TTL + WF14 purge | ✅ | `tests/integration/exports-dashboard.test.ts`; ADR-0013 |
| P5-02 | Policy guard at export: rows of providers without `allowExport` are withheld and listed (never silently dropped) | ✅ | tests; E2E step "default policy" |
| P5-03 | Formula-injection defence (CSV + XLSX); dependency-free XLSX writer | ✅ | `packages/services/test/xlsx.test.ts` (11 tests) |
| P5-04 | `GET /dashboard` | ✅ | tests |
| P5-05 | Web UI: Dashboard, Projects/Project (keywords, discovery coverage, review queue), Accounts, Content Explorer (filters + export), Job Monitor, Automations, Exports, Data Sources | ✅ | real headless-browser screenshots of 8 pages (private, `.data/evidence/phase5/`) |
| P5-06 | Gate: real data end-to-end | ✅ | `npm run phase5:e2e` → `docs/phase5/e2e/2026-11-26T16-41-59-251Z.json`: 8/8 PASS. Real Bluesky discovery → approve → sync → refresh → xlsx/csv/json; workbook opened by openpyxl with 7 sheets and only our own HYPERLINK formulas |

Waiting on the Product Owner: the Bluesky policy proposal (export, history, derived metrics). Until it is approved, Bluesky posts and accounts are withheld from exports.

Tests: `npm test` **156 passed, 1 skipped**.

## Phase 4 — Scheduling, reliability, guards (started 2026-11-26 16:07 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P4-01 | DB-driven scheduler: atomic claim per slot, catch-up = one run, cron with timezone or interval; runs in the scheduler process (BullMQ) or inside the API (inline, no Redis) | ✅ | `tests/integration/scheduler-budget.test.ts` (claim with 2 concurrent runners, 3-day catch-up, pause); ADR-0012 |
| P4-02 | Built-in workflows WF02 (opt-in per project), WF03/04 (due accounts, `sync_interval_minutes`), WF05/06, WF13, WF14 | ✅ | same tests; native smoke `docs/phase4/native-smoke/2026-11-26T16-18-40Z.json` (real app: health SUCCEEDED, metrics refresh fired, WF14 waits for 03:00 Asia/Ho_Chi_Minh) |
| P4-03 | `/workflows` (list, create, edit, validate cron, run now), `/scheduler/pause|resume` | ✅ | tests |
| P4-04 | Budget guard with atomic reservations (advisory lock, expiry, settlement) across all provider calls | ✅ | test: 5 concurrent reservations against a cap of 10 → exactly 10 granted, 2 refused; settlement and expiry release capacity |
| P4-05 | WF14 policy cleanup: provider-deleted posts after a grace period; retention only when the policy states it; housekeeping; audit | ✅ | tests |
| P4-06 | Job monitor `GET /jobs/stats` (counts, active + stuck flag, dead-letter view) | ✅ | tests |
| P4-07 | Restart / retry / cancel | ✅ | Phase 1 review fixes (orphan reconciliation, stall re-delivery, timeout vs cancel) + scheduler catch-up |
| P4-08 | BullMQ-mode run of scheduler + worker (stalls, failed handler) | 🟡 | needs Redis |

Not in scope / later: monetary project budgets need a provider cost model (all enabled providers cost $0); hot-content tiers need WF07 (Phase 6).

Tests: `npm test` **141 passed, 1 skipped**.

## Phase 3 — Keywords, discovery and review (started 2026-11-26 15:51 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P3-01 | Tables `keywords`, `discovery_candidates`, `search_results` | ✅ | migration `20261126155650_discovery_keywords_candidates` |
| P3-02 | Keyword CRUD with normalized dedup; WF01 rule expansion (SUGGESTED, never searched until activated) | ✅ | `packages/services/test/discovery-rules.test.ts` |
| P3-03 | WF02 discovery job `project.discover`: keywords × platforms, budget-checked calls, explicit coverage (OK/ERROR/SKIPPED), profile enrichment | ✅ | `tests/integration/discovery.test.ts` (4 tests) |
| P3-04 | Rule score `rule-v1` 0–100 with reasons, matched keywords, sample posts; low-confidence classification | ✅ | unit tests; ADR-0011 |
| P3-05 | Review queue: list (keyset by score), approve (tracks + queues the sync, respects `max_accounts`), reject (keeps human decisions on re-runs), audit log; opt-in bounded auto-track | ✅ | `tests/integration/discovery.test.ts` |
| P3-06 | Real-data gate run | ✅ | `npm run phase3:discover` → `docs/phase3/discovery/2026-11-26T16-01-12-826Z.json`: "live wallpaper" + "depth wallpaper" on Bluesky → 115 search hits → 67 candidates (34 requests) → top 2 approved → both synced → posts via API. YouTube (AUTH_REQUIRED) and TikTok (BLOCKED) reported as SKIPPED with reasons |

Known limits: account search on Bluesky ignores language; unauthenticated post search is page 1 only (≤100 per query); post-only authors beyond the 30-profile enrichment cap are not stored (`notEnriched`).

Tests: `npm test` **134 passed, 1 skipped**.

## Phase 2 — Production adapters (started 2026-11-26 15:33 UTC)

| ID | Item | Status | Evidence |
|---|---|---|---|
| P2-01 | Metrics refresh job `post.metrics_refresh` (WF05/06): age tiers, batched calls, policy-bound snapshots, provider-confirmed UNAVAILABLE; API `POST /accounts/:id/refresh-metrics`, `POST /metrics/refresh` | ✅ | `tests/integration/metrics-refresh.test.ts` (4 tests); ADR-0010 |
| P2-02 | Provenance and availability fields: `provider_indexed_at` (Bluesky `indexedAt`), `last_metrics_at`, `unavailable_at/reason`; `GET /posts` hides UNAVAILABLE unless `includeUnavailable=true` | ✅ | migration `20261126153529_posts_availability_and_metrics_refresh` |
| P2-03 | Shared adapter contract suite (12 checks) run by every production adapter | ✅ | `packages/collectors/core/src/contract.ts`; 12/12 pass for Bluesky and for YouTube (fake API, SYNTHETIC) |
| P2-04 | Real-data sync: 3 Bluesky accounts → initial + incremental sync → metrics refresh → API | ✅ | `npm run phase2:sync` → `docs/phase2/real-sync/2026-11-26T15-46-42-909Z.json`: 84 real posts, 0 duplicates, all with provenance and `indexedAt`, refresh updated 46/46 due posts in 2 requests, every collection run has usage recorded |
| P2-05 | YouTube live verification (sync, metrics, quota units) | 🟡 | Code and contract tests done. Waiting for `YOUTUBE_API_KEY` |
| P2-06 | TikTok / Meta | 🟡 | Blocked by platform access (ADR-0006). Waiting for the Product Owner decisions in `docs/feasibility/README.md` §5 |

Tests: `npm test` **122 passed, 1 skipped** (BullMQ test, needs Redis).

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
- 2026-11-26 15:33 — Product Owner: continue with Phase 2.
- 2026-11-27 ~01:45 (UTC+7) — Phase 9: P9-04 Ad Spy desk research (Meta AUTH_REQUIRED, Google BLOCKED, TikTok LEGAL_RISK).
- 2026-11-27 ~01:35 (UTC+7) — Phase 9: P9-03 App Spy (Apple VERIFIED with 2 live runs; Google Play BLOCKED), real-data check in the app.
- 2026-11-27 ~01:15 (UTC+7) — Phase 9: P9-01 workflow DAG engine and P9-02 visual editor (verified in a real browser). 186 tests passing.
- 2026-11-27 ~00:50 (UTC+7) — Phase 8: backups + restore test, security hardening/check, metrics, load report. 176 tests passing.
- 2026-11-27 ~00:30 (UTC+7) — Phase 7: reports, notifications, MCP server, n8n templates; real-data MCP gate 6/6. 171 tests passing.
- 2026-11-27 ~00:15 (UTC+7) — Phase 6: viral-v1, trends-v1, AI analysis (Claude SDK), Insights UI; real-data run 6/6. 166 tests passing.
- 2026-11-26 ~16:45 — Phase 5: exports with policy guard, dashboard API, full web UI; real-data E2E 8/8. 156 tests passing.
- 2026-11-26 16:07 — Product Owner: build all phases in order; keys and Redis will be provided later.
- 2026-11-26 ~16:20 — Phase 4: DB scheduler, workflows API, reservations budget guard, WF14 cleanup, job monitor. 141 tests passing.
- 2026-11-26 15:51 — Product Owner: continue with Phase 3.
- 2026-11-26 ~16:01 — Phase 3: keywords, rule expansion, discovery job, rule score, review queue; real-data gate run passed. 134 tests passing.
- 2026-11-26 ~15:50 — Phase 2: metrics refresh, availability fields, shared contract suite, real-data sync of 3 Bluesky accounts. 122 tests passing.
- 2026-11-26 ~15:30 — Phase 1 code review done: 7 bugs fixed with regression tests (see above). `npm test`: 94 passed, 1 skipped. Native start/stop re-checked on Windows.
