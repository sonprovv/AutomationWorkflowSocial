# NEXT STEPS

Updated 2026-11-26 after resuming. The full status and test evidence are in [`PROGRESS.md`](PROGRESS.md).

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
| 4 | Product Owner decisions | Listed in `docs/feasibility/README.md` §5:<br>- Bluesky policy proposal<br>- TikTok option (manual URL + oEmbed is recommended)<br>- Meta App Review<br>- paid sources (X, Apify) |
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
4. 🟡 **IN PROGRESS (2026-11-27 ~01:40): official docs read for Meta (ads_archive + archived-ad reference, Transparency Center) and TikTok (Commercial Content API docs + Developer Terms). Google Ads Transparency Center: its pages are JavaScript shells and the BigQuery dataset page failed to load, so still unverified. Next: write `docs/feasibility/ad-spy.md` and `docs/feasibility/ad-sources/*.json` (records only, no adapter), then the close-out.** **P9-04 Ad Spy, desk research:** Meta Ad Library API (identity verification and token: AUTH_REQUIRED), Google Ads Transparency Center (no API: BLOCKED), TikTok Commercial Content API (application required). Write the report and capability records only. Do not infer spend, revenue or ROAS.
5. **Close-out:** check the MVP acceptance checklist (§17.2) against PROGRESS; final summary for the Product Owner.

## Environment notes for this machine
- Windows 11, Node 22.16, npm 10.9, Git, Python 3.12, .NET 8 SDK. **No Docker, WSL or Redis.**
- Local app data is in `.data/` (git-ignored): the embedded PostgreSQL on port 18968 and its random password in `.data/postgres.secret`.
- App URL: http://127.0.0.1:18966. Start with `start.bat`, stop with `stop.bat`.
- `git push` to `origin` (github.com/sonprovv/AutomationWorkflowSocial) works from this session.
- `cc-bot.bat` is user-local, contains personal account info, and is excluded via `.git/info/exclude`. Never commit it.
