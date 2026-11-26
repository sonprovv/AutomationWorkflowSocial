# Social Spy Automation

A local-first platform for researching competitors and their content on social networks.

- Specification: [`SOCIAL_SPY_AUTOMATION_PLAN.md`](SOCIAL_SPY_AUTOMATION_PLAN.md)
- Progress and test evidence: [`PROGRESS.md`](PROGRESS.md)
- Design decisions: [`docs/adr/`](docs/adr/)

> **Status (2026-11-27): Phases 1–9 are built and tested** (`npm test`: 204 passed, 1 skipped), and they run locally without Docker. What you can do:
> - track competitor accounts and discover new ones (Bluesky, real data);
> - schedule syncs, browse the dashboard and Content Explorer, export files, and get reports and notifications;
> - use the MCP tools, encrypted backups, and the visual **Workflow Builder**;
> - research iOS apps in **App Spy**.
>
> Open items are listed under [Status, limitations and decisions waiting](#status-limitations-and-decisions-waiting). The biggest one: **only one social source is verified (Bluesky)**. YouTube needs `YOUTUBE_API_KEY`, so the Phase 0 gate is still open ([ADR-0007](docs/adr/0007-phase0-gate-deferred.md)).

## Quick start (no Docker)

You need **Node.js 22 LTS**.

| | Windows | macOS |
|---|---|---|
| Start | Double-click **`start.bat`** | `chmod +x start.command stop.command`, then `./start.command` |
| Stop | `stop.bat`, or Ctrl+C in the start window | `./stop.command`, or Ctrl+C |
| Diagnose | `scripts\doctor.cmd` | `./scripts/doctor.sh` |

On the first run, `start`:
1. installs dependencies;
2. creates `.env`;
3. starts an embedded PostgreSQL (data stored in `.data/`);
4. applies database migrations;
5. builds the UI;
6. opens **http://127.0.0.1:18966**.

To change the port, set `APP_PORT` in `.env`.

### Optional: install Redis for background jobs and schedules

Without Redis, the app runs in **inline mode**: jobs run inside the API process and schedules are disabled.

| OS | Command |
|---|---|
| Windows | `winget install Memurai.MemuraiDeveloper` |
| macOS | `brew install redis && brew services start redis` |

Restart the app after installing.

### Optional: Docker

Use `start.bat --docker` or `./start.command --docker`. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Credentials (`.env`, git-ignored)

Never paste keys into chat tools.

| Variable | Purpose |
|---|---|
| `YOUTUBE_API_KEY` | YouTube Data API v3. The YouTube provider stays disabled until it is verified (`npm run poc -- youtube`). |
| `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` | Optional. Enables Bluesky search pagination. Use an App Password, not your main password. |

## Developer commands

| Command | What it does |
|---|---|
| `npm ci` | Install dependencies and generate the Prisma client |
| `npm run typecheck` | Type-check everything, including the web app |
| `npm test` | Unit, contract and integration tests on an embedded PostgreSQL. No network, no credentials. |
| `npm run test:live` | Opt-in smoke tests against the real providers, with a small budget |
| `npm run slice -- <profile URL>` | Real-data vertical slice: URL → provider → DB → API. Writes an evidence report. |
| `npm run poc -- bluesky\|youtube` | Phase 0 feasibility run against the real providers |
| `npm run poc:summary` | Summarise the Phase 0 runs |
| `npm run poc:apps` | App Spy feasibility run against the real Apple iTunes Search API (about 40 s, paced) |
| `npm run backup` / `npm run backup -- verify` | Encrypted backup / restore test into a throwaway database |
| `npm run security:check` | Secret scan, ignore rules, safe defaults, `npm audit` |
| `npm run mcp` | MCP server for agents (`docs/MCP.md`) |
| `npm run doctor` | Environment diagnostics |
| `npm run db:migrate:new -- <name>` | Create a database migration. Uses a throwaway embedded PostgreSQL. |
| `npm run dev -w @sss/web` | Vite dev server with `/api` proxied to `APP_PORT` |

API documentation: `/api/docs` when the app is running, or [`docs/API_SPEC.md`](docs/API_SPEC.md).

## Layout

```text
apps/api            Fastify REST API (/api/v1), OpenAPI, serves the UI in native mode
apps/worker         BullMQ workers
apps/scheduler      BullMQ job schedulers (DB-defined schedules)
apps/web            React UI: dashboard, explorer, insights, App Spy, job monitor, workflow builder, exports, reports
apps/mcp            MCP server (tools over the REST API)
packages/collectors core contract, bluesky, youtube, registry, appstore (App Spy)
packages/database   Prisma schema/migrations, embedded PostgreSQL, seeding
packages/services   business logic: projects, tracking, sync, posts, jobs, providers, usage
packages/queue      queues, payloads, idempotency keys, BullMQ and inline dispatchers
packages/policy-engine  data policy decisions (deny by default)
packages/config, packages/shared
tools/feasibility   Phase 0 / App Spy proof-of-concept harness, ad-source records
tools/local         native start/stop/doctor, migrate-seed, vertical slice
docs/               architecture, API, database, deployment, runbook, feasibility, ADRs
```

## Data rules
- No fabricated data. Fixtures are labelled, and every record carries provenance (provider, collection time, policy).
- A missing value is stored as `null` with a reason, never as `0`.
- Every provider has a data policy, and it is deny-by-default until verified. YouTube in particular: data is kept for at most 30 days and no derived metrics are computed (ADR-0004).
- No scraping and no bypassing of access controls. Unsupported sources are shown as `BLOCKED` or `AUTH_REQUIRED`, with the reason.

- Spend, revenue, ROAS, downloads and rankings are never inferred. A value is shown only if the source publishes it.

Troubleshooting: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Status, limitations and decisions waiting

The full checklist with evidence is in [`PROGRESS.md`](PROGRESS.md) under "MVP acceptance". In short:

| Waiting on | What | Where |
|---|---|---|
| You: `YOUTUBE_API_KEY` | The second verified social source (MVP gate); 3 live PoC runs | `NEXT_STEPS.md` |
| Product Owner | Bluesky policy proposal (history, derived metrics, export) | `docs/feasibility/capabilities/bluesky.json` |
| Product Owner | Apple App Store policy proposal (snapshots, export) | `docs/feasibility/app-stores/apple.json` |
| Product Owner | Ad Spy: Meta identity confirmation and app, Google BigQuery project, TikTok legal advice | `docs/feasibility/ad-spy.md` |
| You: channel settings | Real Telegram, email or webhook delivery of reports | `.env`, Reports page |
| You: `ANTHROPIC_API_KEY` | AI analysis | `.env` |

Known limits:
- **Not tested here:** macOS, Docker mode and BullMQ with a real Redis. Only Windows and the inline queue were run.
- **Google Play, TikTok, LinkedIn competitor posts and the Google Ads Transparency Center are BLOCKED.** Facebook, Instagram, Threads, X and Pinterest are AUTH_REQUIRED (`docs/feasibility/README.md`).
- **App Spy** covers iOS only, keeps the latest listing (no history), and cannot link apps whose listing has no developer website.
