# ADR-0013: Exports with a policy guard, and the Phase 5 web UI

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 5

## Context
Master Plan §10 and §12 ask for:
- a dashboard and a Content Explorer with server-side filters;
- exports to Excel, CSV and JSON with a data dictionary and provenance;
- formula-injection handling;
- policy checks at export time.

The Bluesky effective policy is deny-by-default (`allowExport=false`) until the Product Owner approves the policy proposal.

## Decisions

### 1. Exports (WF17): job `export.generate`, queue `report`, table `exports`
- `POST /exports {format, projectId?, filters}` reuses the Content Explorer filters (`postWhere`). It returns 202 with a job. Files go to `EXPORT_DIR` (default `.data/exports`, git-ignored) and expire after `EXPORT_TTL_DAYS` (default 7). WF14 deletes expired files and rows.
- **Workbook sheets** (§12): `Summary` (filters, timezone, time range, coverage, withheld rows, what is not included and why), `Accounts`, `Posts`, `Keywords` (project exports), `Collection_Log`, `Usage`, `Data_Dictionary`.
- These sheets are not produced, and `Summary` says why:
  - `Metrics_History`: the policy does not allow history.
  - `Viral`, `Trends`, `AI_Analysis`: Phase 6, policy-gated.
- **CSV** contains the posts table. **JSON** contains meta, data dictionary, accounts, posts and keywords.
- **Policy guard:** rows from a provider whose effective policy has `allowExport=false` are **withheld**. Each export records the withheld counts per provider, with the policy id and reason, and the workbook `Summary` lists them. Thumbnail URLs are included only when `allowMediaProcessing` is true. Nothing is dropped silently.
- **Formula injection** (OWASP): text from external sources that starts with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`, in both CSV and XLSX. In XLSX, text is always written as inline strings, never as formulas. The only formulas are `HYPERLINK` cells that we build from validated `https://` URLs, with quotes escaped.
- Missing values are empty cells, and the reason is in `missing_reason`. They are never 0.
- Sheets are capped at `EXPORT_MAX_POSTS` (default 50,000), with a warning when the cap is hit. Streaming or multi-file partitioning is deferred until data volumes need it.

### 2. Dependency-free XLSX writer
`packages/services/src/xlsx.ts` is a small OOXML writer (deflate ZIP, CRC32, inline strings, a bold frozen header, a hyperlink style). It avoids a large spreadsheet dependency and the supply-chain risk that comes with one. Its correctness is checked in three ways:
- unit tests that read the ZIP back and verify each CRC;
- a CRC32 check-value test;
- an independent reader (`openpyxl`) in the Phase 5 E2E run (`tools/local/scripts/validate_xlsx.py`).

### 3. Web UI
- React with hash routing, served by the API as a static bundle.
- Screens: Dashboard, Projects / Project (keywords, rule suggestions, discovery with a coverage table, review queue with evidence and bulk approve/reject), Accounts / Account (sync, refresh metrics, sync history), Content Explorer (server-side filters, keyset "load more", export of the current filters), Job Monitor (stats, stuck jobs, dead letter, retry/cancel), Automations (schedules, enable, interval, run now, pause/resume), Exports, Data Sources.
- UI rules:
  - every number shows its source and collection time;
  - a missing value shows "—" with the reason;
  - external links open with `noopener` and are `https`-only;
  - captions are rendered as text;
  - empty states are distinct from errors.
- Light and dark mode follow the operating system.
- These screens come later: Viral Feed, Trends and AI Intelligence (Phase 6); Alerts and Reports (Phase 7); Settings, backup and the workflow builder (Phases 8–9).

### 4. `GET /dashboard`
Server-side counts, posts per day (14 days), latest posts, the most-liked posts in the last 7 days, provider coverage with usage, reservations and cost today, scheduler state and job status.
- "Most liked" is a plain sort by the raw count the provider reports, and the UI labels it as such. It is not a viral score.
- Posts without a count are not ranked as 0.

## Consequences
- **Default policy:** a Bluesky export contains only our own operational data (keywords, collection log, usage) plus the withheld notice. Approving the Bluesky policy proposal (`policyProposal.status = "APPROVED"` in `docs/feasibility/capabilities/bluesky.json`, then restart) makes posts and accounts exportable.
- **E2E evidence:** the committed report has structure only (counts and headers). Workbooks and screenshots contain third-party content, so they stay in `.data/evidence/` (git-ignored).
