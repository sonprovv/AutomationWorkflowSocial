# Social Spy Automation

A local-first platform for researching competitors and their content on social networks.

- Specification: [`SOCIAL_SPY_AUTOMATION_PLAN.md`](SOCIAL_SPY_AUTOMATION_PLAN.md)
- Progress and test evidence: [`PROGRESS.md`](PROGRESS.md)
- Design decisions: [`docs/adr/`](docs/adr/)

> **Current stage: Phase 1, the platform skeleton.** It runs locally today: track an account by URL, sync it from real data (Bluesky), browse the results in the API and a minimal UI, and manage the jobs.
>
> Arriving in later phases: discovery, scheduled workflows, the full dashboard, exports, AI, and MCP.
>
> Phase 0 is still open until a YouTube key is verified ([ADR-0007](docs/adr/0007-phase0-gate-deferred.md)).

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
| `npm run doctor` | Environment diagnostics |
| `npm run db:migrate:new -- <name>` | Create a database migration. Uses a throwaway embedded PostgreSQL. |
| `npm run dev -w @sss/web` | Vite dev server with `/api` proxied to `APP_PORT` |

API documentation: `/api/docs` when the app is running, or [`docs/API_SPEC.md`](docs/API_SPEC.md).

## Layout

```text
apps/api            Fastify REST API (/api/v1), OpenAPI, serves the UI in native mode
apps/worker         BullMQ workers
apps/scheduler      BullMQ job schedulers (DB-defined schedules)
apps/web            minimal React UI (full dashboard comes in Phase 5)
packages/collectors core contract, bluesky, youtube, registry
packages/database   Prisma schema/migrations, embedded PostgreSQL, seeding
packages/services   business logic: projects, tracking, sync, posts, jobs, providers, usage
packages/queue      queues, payloads, idempotency keys, BullMQ and inline dispatchers
packages/policy-engine  data policy decisions (deny by default)
packages/config, packages/shared
tools/feasibility   Phase 0 proof-of-concept harness
tools/local         native start/stop/doctor, migrate-seed, vertical slice
docs/               architecture, API, database, deployment, runbook, feasibility, ADRs
```

## Data rules
- No fabricated data. Fixtures are labelled, and every record carries provenance (provider, collection time, policy).
- A missing value is stored as `null` with a reason, never as `0`.
- Every provider has a data policy, and it is deny-by-default until verified. YouTube in particular: data is kept for at most 30 days and no derived metrics are computed (ADR-0004).
- No scraping and no bypassing of access controls. Unsupported sources are shown as `BLOCKED` or `AUTH_REQUIRED`, with the reason.

Troubleshooting: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
