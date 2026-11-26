# Social Spy Automation

A local-first platform for researching competitors and content across social networks. The full specification is [`SOCIAL_SPY_AUTOMATION_PLAN.md`](SOCIAL_SPY_AUTOMATION_PLAN.md) and progress is tracked in [`PROGRESS.md`](PROGRESS.md).

> **Current stage: Phase 0 (Data Source Feasibility).**
> The repository contains:
> - the collector SDK core,
> - Bluesky and YouTube adapters,
> - a proof-of-concept (PoC) harness that exercises them against the real APIs,
> - feasibility reports for 10 platforms.
>
> It does not yet have the dashboard, database or job queue. Those start in Phase 1.

## Requirements
- Node.js 22 LTS (`>=22.12`). Check with `node -v`.
- Windows 10/11 (PowerShell or Git Bash) or macOS. Docker is **not** needed for Phase 0.

## Setup

```bash
npm ci
```

Create your local `.env` from the template. It is git-ignored and must never be committed.

| Shell | Command |
|---|---|
| macOS / Git Bash | `cp .env.example .env` |
| Windows PowerShell | `Copy-Item .env.example .env` |

Then fill in what you have:

| Variable | Needed for | Notes |
|---|---|---|
| `YOUTUBE_API_KEY` | YouTube | In Google Cloud, enable **YouTube Data API v3**, create an API key and restrict it to that API. |
| `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD` | Bluesky search pagination (optional) | Use an App Password created under Bluesky Settings → App Passwords. **Never use your main password.** |
| `YOUTUBE_POC_MAX_UNITS`, `BLUESKY_POC_MAX_REQUESTS` | Budget caps per run | Optional. |

Keep secrets in `.env` only. Do not paste API keys into chat tools.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`). |
| `npm test` | Unit and contract tests. Uses a local fake server: no network, no credentials, no cost. |
| `npm run test:live` | Opt-in live smoke tests with small budgets. YouTube tests are skipped when no key is set. |
| `npm run poc -- bluesky` | Phase 0 PoC against the real Bluesky API. No credentials needed. |
| `npm run poc -- youtube` | Phase 0 PoC against the real YouTube API. Needs `YOUTUBE_API_KEY`. |
| `npm run poc -- <platform> --dry-run` | Prints the targets and budget without calling the network. |
| `npm run poc:summary` | Aggregates every run into `docs/feasibility/runs/<platform>/SUMMARY.md`. |

Each PoC run writes two files, both with secrets redacted:
- the full report to `docs/feasibility/runs/<platform>/<timestamp>.json`;
- a small sample of normalized records to `docs/feasibility/samples/`.

PoC targets (accounts and keywords) are configured in `tools/feasibility/targets/<platform>.json`.

## Layout

```text
packages/collectors/core      shared contract: types, typed errors, HttpClient, UsageMeter, redaction, validation
packages/collectors/bluesky   Bluesky AppView adapter
packages/collectors/youtube   YouTube Data API v3 adapter
tools/feasibility             Phase 0 PoC CLI and run summary
tests/fixtures                fixtures, labelled SYNTHETIC or CAPTURED
docs/feasibility              per-platform reports, capability JSON, run logs, samples, research notes
docs/adr                      architecture decision records
```

## Data rules (summary)
- No fabricated data. Fixtures are labelled, and every collected record carries provenance.
- A missing value is stored as `null` with a reason. It is never stored as `0`.
- Policies are deny-by-default until verified. See `docs/feasibility/capabilities/*.json`.
- No scraping, and no bypassing of CAPTCHAs, rate limits or access controls. Unsupported sources are marked `BLOCKED` or `AUTH_REQUIRED`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `process.loadEnvFile is not a function` | Your Node version is too old. Install Node 22. |
| YouTube `INVALID` | The key is wrong. Re-copy it. |
| YouTube `API_DISABLED` | Enable YouTube Data API v3 in the key's Google Cloud project. |
| YouTube `QUOTA_EXCEEDED` | The daily quota is used up. It resets at midnight Pacific Time. |
| Bluesky search page 2 returns `PERMISSION_DENIED` | Expected without auth. Set an App Password (see ADR-0005). |
| `BUDGET_EXCEEDED` | The per-run cap was reached. Raise `*_POC_MAX_*` in `.env`. |
