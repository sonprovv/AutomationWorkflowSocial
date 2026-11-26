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

**Next: Phase 7** (Master Plan §16): MCP server, Telegram/email notifications, daily/weekly reports, n8n templates. Gate: agent tool call → job → export/report.

## Environment notes for this machine
- Windows 11, Node 22.16, npm 10.9, Git, Python 3.12, .NET 8 SDK. **No Docker, WSL or Redis.**
- Local app data is in `.data/` (git-ignored): the embedded PostgreSQL on port 18968 and its random password in `.data/postgres.secret`.
- App URL: http://127.0.0.1:18966. Start with `start.bat`, stop with `stop.bat`.
- `git push` to `origin` (github.com/sonprovv/AutomationWorkflowSocial) works from this session.
- `cc-bot.bat` is user-local, contains personal account info, and is excluded via `.git/info/exclude`. Never commit it.
