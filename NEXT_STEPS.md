# NEXT STEPS

Updated 2026-11-27 after Phase 9. The full status and test evidence are in [`PROGRESS.md`](PROGRESS.md).

> **All planned phases (0–9) are built.** The MVP acceptance table is in PROGRESS.md under "MVP acceptance". Acceptance is blocked only by item #2: a second verified social source, which needs `YOUTUBE_API_KEY` (row 1 below). Nothing else is in progress. When resuming, run `npm test` first; the last run had 204 passing and 1 skipped.

## Where we stopped
- **Phase 0:** code, tests and docs are done. The **gate is still open** until a YouTube API key is verified (ADR-0007).
- **Phase 1:** the core is done and tested with real data (94 tests passing, 1 skipped). These items are still open:
  - BullMQ path: needs Redis.
  - Docker mode: not run.
  - macOS: not tested.

## Done since resuming
- Bluesky PoC run 3 (24/3/1, same as runs 1–2). Docs now say 3 runs.
- Phase 1 code review: 7 bugs fixed with regression tests. See `PROGRESS.md` → "Bugs found by the Phase 1 code review".
  - Still to verify once Redis is installed: the worker `failed` handler and the startup orphan check against a real BullMQ (stalled jobs).

## Waiting on the user / Product Owner
| # | Item | What to do |
|---|---|---|
| 1 | `YOUTUBE_API_KEY` in `.env` | The user said keys come at the end. Once it is set:<br>1. Run `npm run poc -- youtube` three times at different times.<br>2. Run `npm run poc:summary`.<br>3. Set `docs/feasibility/capabilities/youtube.json` → `"status": "VERIFIED"`, with capabilities based on the run evidence.<br>4. Update `youtube.md`.<br>5. Restart; the seed then enables the provider.<br>Running `npm test` afterwards will fail on the capability drift test until the record and the adapter capabilities match. |
| 2 | Redis | `winget install Memurai.MemuraiDeveloper` (Windows) or `brew install redis` (macOS). Then run `npm test`; `tests/integration/bullmq.test.ts` runs automatically. Then `start.bat` should report "worker + scheduler mode". |
| 3 | Bluesky App Password (optional) | Set `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD`. Then re-run the PoC; TC06 page 2 should pass. |
| 4 | Product Owner decisions | Listed in `docs/feasibility/README.md` §5:<br>- Bluesky policy proposal<br>- TikTok option (manual URL + oEmbed is recommended)<br>- Meta App Review<br>- paid sources (X, Apify)<br>Phase 9 adds:<br>- the Apple App Store policy proposal (`docs/feasibility/app-stores/apple.json`)<br>- the Ad Spy options (`docs/feasibility/ad-spy.md`) |
| 5 | Docker (optional) | `start.bat --docker` on a machine with Docker Desktop, to verify `docker-compose.yml`. |

## Phase 2 status
Bluesky is done with real data (see `PROGRESS.md` → Phase 2). Open:
- **YouTube live verification.** Once `YOUTUBE_API_KEY` is set and the Phase 0 runs are done, run `npm run phase2:sync -- https://www.youtube.com/@GoogleDevelopers` (add any channels) and check the quota units in the report.
- **TikTok / Meta.** These wait on the Product Owner decisions above.

## Phase 3 status
The gate passed with real Bluesky data: seed keyword → candidates → approved account → posts (`docs/phase3/discovery/`, ADR-0011). Open:
- **YouTube discovery.** This needs the key. Once the key is in, re-run `npm run phase3:discover`; YouTube search costs 100 quota units per call, so keep `max_keywords_per_run` small.
- **Web UI** for keywords and the review queue. The API is ready; the UI comes with Phase 5.

## Phase 4 status
Done (ADR-0012). Schedules now also run without Redis (inside the API). Open: once Redis is installed, run `start.bat` and check that it reports "worker + scheduler mode", that `GET /workflows` shows runs, and that `tests/integration/bullmq.test.ts` passes.

## Phase 5 status
Done (ADR-0013). Bluesky rows are withheld from exports until the policy proposal is approved: set `policyProposal.status` to `"APPROVED"` in `docs/feasibility/capabilities/bluesky.json` and restart.

## Phase 6 status
Done (ADR-0014). Waiting on:
- **The Product Owner**, to approve `allowDerivedMetrics` in the Bluesky policy proposal. Until then viral, trends and AI report "blocked by policy".
- **`ANTHROPIC_API_KEY`** in `.env`. Then run `npm run phase6:analytics` again, or click "Analyse top posts" on the Insights page.

## Phase 7 status
Done (ADR-0015, `docs/MCP.md`). To receive reports, set the channel settings in `.env` (any of them), then click "Send test notification" on the Reports page:
- **Telegram:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (use a dedicated report bot or chat);
- **Email:** `SMTP_URL`, `EMAIL_FROM` and `EMAIL_TO`;
- **Webhook:** `WEBHOOK_URL` and `WEBHOOK_SECRET`.

## Phase 8 status
Done (ADR-0016). Notes for the user:
- **Back up the backup key.** `.data/backup.key` (created by the first backup) must be copied somewhere safe. Alternatively set `BACKUP_PASSPHRASE` in `.env` before the next backup.
- **Before exposing the app beyond this computer,** follow `docs/DEPLOYMENT.md` §3 (`API_TOKEN`, HTTPS).

## Phase 9 plan (post-MVP; started 2026-11-27)
Work in this order, and commit after each item so that work can resume from here:
1. ✅ **DONE (2026-11-27; tests in `tests/integration/workflow-builder.test.ts`)** **P9-01 Workflow DAG engine:** tables `workflows`, `workflow_versions` (immutable JSON) and `workflow_runs`.
   - Validation: the graph is acyclic; node types come from a whitelist; loops are bounded; each node has a timeout and an error policy.
   - Execution: nodes map to the existing jobs (discover, sync, metrics, viral, trends, AI, export, report, notify) or to wait/filter/if nodes, run in topological order.
   - API: `/workflow-defs`. The route `/workflows/:id/graph` stops returning 501.
2. ✅ **DONE (2026-11-27; ADR-0017, page `#/builder`, tests in `apps/web/test/graph-edit.test.ts`; checked in a real browser)** **P9-02 Visual editor:** a page that edits the DAG (nodes, edges, node config), validates it, saves a new version and runs it. Use React Flow if a release older than 2 weeks is available, otherwise a small SVG editor.
3. ✅ **DONE (2026-11-27; ADR-0018, `docs/feasibility/apple-app-store.md` and `google-play-apps.md`, page `#/apps`; Product Owner: decide the Apple policy proposal in `docs/feasibility/app-stores/apple.json`)** **P9-03 App Spy, Phase 0 first:** a feasibility PoC for the Apple iTunes Search/Lookup API (public and official) for app search, details, developer and website. Google Play has no official search API, so it is BLOCKED (manual URL only) and gets a report.
   - If verified: an adapter, a `apps` table, and app → developer website → social account linking with evidence (never match by name alone).
4. ✅ **DONE (2026-11-27; `docs/feasibility/ad-spy.md` and `ad-sources/*.json`, schema-tested; Product Owner decisions are listed in ad-spy.md)** **P9-04 Ad Spy, desk research:** Meta Ad Library API (identity verification and token: AUTH_REQUIRED), Google Ads Transparency Center (no API: BLOCKED), TikTok Commercial Content API (application required). Write the report and capability records only. Do not infer spend, revenue or ROAS.
5. ✅ **DONE (2026-11-27): MVP acceptance table and Product Owner summary in PROGRESS.md (MVP acceptance); README refreshed.** **Close-out:** check the MVP acceptance checklist (§17.2) against PROGRESS; final summary for the Product Owner.

## UI refresh + setup guide: DONE (2026-11-27)
- **New look:** sidebar navigation, card layout, `.primary` buttons, light and dark themes (`apps/web/src/styles.css`, `icons.tsx`).
- **Setup guide dialog** (`SetupGuide.tsx`) backed by `GET /setup/status`. That endpoint returns booleans and counts only; a test checks that no secret value leaks.
- "Automations" was renamed "Schedules" in the UI.

## Language EN/VI + theme switch: DONE (2026-11-27)
- **Plan:**
  1. i18n: `apps/web/src/i18n/` with a `useT()` hook, dictionaries in `en` and `vi`, the choice kept in localStorage, `<html lang>` set.
  2. Translate the shell, the setup guide and the shared UI first, then every page.
  3. Theme: System, Light or Dark, using a `data-theme` attribute on `<html>`, kept in localStorage. CSS tokens follow `[data-theme]`, with `prefers-color-scheme` as the System default.
  4. Switches in the sidebar footer.
- **Done:** every page, the shell and the setup guide are translated (messages sit next to each component in `defineMessages`). The theme can be System, Light or Dark. Both choices are kept per browser, and dates and numbers follow the chosen language. **When adding UI text, add both languages.**

## Feature guide / tutorial dialog: DONE (2026-11-27)
- **Plan:** `apps/web/src/FeatureGuide.tsx`, a two-column modal.
  - Left: a list of features in the suggested order. Right: what the feature is for, step-by-step use, tips and limits, and an "Open page" button.
  - Bilingual (EN/VI).
  - Opens from the sidebar ("User guide"), from a "?" button on each page (jumping to that page's section), and from the setup guide footer.

## Demo videos, one per feature: PARKED (2026-11-27 ~02:12, the user said to leave it for now)
**Request:** realistic demo videos, one per feature, and a "Watch demo" button in the user guide.

**Done so far:**
- `tools/demo/src/browser.ts`: a CDP driver for headless Edge/Chrome. It records with `Page.startScreencast` (JPEG frames plus timestamps) and dispatches real mouse/keyboard input (click, type, drag, wheel, select). An injected overlay adds a visible cursor with click ripple, a caption bar and a title card. Overlays run through CDP, so they are not affected by the page CSP. Typechecks; not run yet.
- `tools/demo/package.json` (workspace `@sss/demo`).
- ffmpeg 9 is installed (winget, Gyan build) and on PATH.

**To do when resuming:**
1. `tools/demo/src/record.ts`, the orchestrator:
   - Start a separate demo instance: embedded PG in a temp dir on its own port, `migrateDeploy`, `seedFromCapabilityRecords`, then spawn `apps/api/src/main.ts`. Use `API_PORT=18990`, `QUEUE_DRIVER=inline`, `SERVE_WEB=true`, `NODE_ENV=development`.
   - Point `EXPORT_DIR`, `BACKUP_DIR` and `BACKUP_KEY_FILE` at the temp dir.
   - Blank `TELEGRAM_*`, `SMTP_URL`, `WEBHOOK_URL` and `ANTHROPIC_API_KEY` so nothing real is sent or spent. The user's `.data/` is never touched; `process.loadEnvFile` does not override variables already set.
   - Seed real Bluesky data through the API:
     - a project with keywords (`atproto`);
     - track `atproto.com` and `bsky.app`, then run discovery;
     - App Spy: track Goodnotes (id 1444383602) and discover its links;
     - a workflow from the weekly-scan template;
     - a daily report and an export.
2. `tools/demo/src/scenes.ts`: one scene per FeatureGuide section id (start, dashboard, projects, accounts, explore, insights, apps, builder, workflows, jobs, exports, reports, sources). Each scene:
   - opens with a title card, then performs real actions with EN/VI captions;
   - uses structural selectors or text pairs `[en, vi]` (labels are in each page's `defineMessages`);
   - in Insights, shows "blocked by policy" honestly.
3. Encode with the ffmpeg concat demuxer, using frame durations from the timestamps:
   - `-c:v libx264 -crf 30 -preset veryfast -r 25 -movflags +faststart`;
   - output `apps/web/public/demos/<id>.<lang>.mp4` plus `manifest.json`.
   - Decide git vs ignore by total size (keep it out of git if over about 25 MB, and document `npm run demo:record`).
4. Root script `"demo:record": "tsx tools/demo/src/record.ts"` with `--lang vi,en` and `--only <ids>`.
5. FeatureGuide: fetch `/demos/manifest.json`. Show a "Watch demo / Xem demo" button when a video exists for the section; it plays inline with controls. Restart the app after the build (static files are registered at startup).

## Environment notes for this machine
- Windows 11, Node 22.16, npm 10.9, Git, Python 3.12, .NET 8 SDK. **No Docker, WSL or Redis.**
- Local app data is in `.data/` (git-ignored): the embedded PostgreSQL on port 18968 and its random password in `.data/postgres.secret`.
- App URL: http://127.0.0.1:18966. Start with `start.bat`, stop with `stop.bat`.
- `git push` to `origin` (github.com/sonprovv/AutomationWorkflowSocial) works from this session.
- `cc-bot.bat` is user-local, contains personal account info, and is excluded via `.git/info/exclude`. Never commit it.
