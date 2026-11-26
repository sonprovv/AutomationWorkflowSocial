# NEXT STEPS — resume here

Paused on 2026-11-26 at about 10:00 UTC, at the Product Owner's request ("dừng lại, note lại sau làm tiếp").
The last pushed commit is on `main` (see `git log`). The full status and test evidence are in [`PROGRESS.md`](PROGRESS.md).

## Where we stopped
- **Phase 0:** code, tests and docs are done. The **gate is still open** until a YouTube API key is verified (ADR-0007).
- **Phase 1:** the core is done and tested with real data (89 tests passing, 1 skipped). These items are still open:
  - BullMQ path: needs Redis.
  - Docker mode: not run.
  - macOS: not tested.

## Interrupted or cancelled when we paused
1. **Independent code review of Phase 1** (services, jobs, processor, queue, API, worker, scheduler, start/stop). It was stopped before producing any findings, so run it again first when resuming. Suggested focus:
   - job status transitions under BullMQ retries and stalled jobs (can a job get stuck in RUNNING or QUEUED?);
   - the scheduled-job path in `packages/services/src/processor.ts`;
   - usage-guard accounting;
   - incremental sync watermark and stop logic;
   - keyset pagination;
   - error-handler status mapping;
   - `tools/local/src/start.ts` shutdown paths on Windows.
2. **Bluesky PoC run 3** (it was scheduled for 17:13 and cancelled). Run it manually:
   ```
   npm run poc -- bluesky --label run3
   npm run poc:summary
   ```
   Then update `docs/feasibility/bluesky.md`, `docs/feasibility/README.md` and `PROGRESS.md` to say 3 runs.

## Waiting on the user / Product Owner
| # | Item | What to do |
|---|---|---|
| 1 | `YOUTUBE_API_KEY` in `.env` | The user said keys come at the end. Once it is set:<br>1. Run `npm run poc -- youtube` three times at different times.<br>2. Run `npm run poc:summary`.<br>3. Set `docs/feasibility/capabilities/youtube.json` → `"status": "VERIFIED"`, with capabilities based on the run evidence.<br>4. Update `youtube.md`.<br>5. Restart; the seed then enables the provider.<br>Running `npm test` afterwards will fail on the capability drift test until the record and the adapter capabilities match. |
| 2 | Redis | `winget install Memurai.MemuraiDeveloper` (Windows) or `brew install redis` (macOS). Then run `npm test`; `tests/integration/bullmq.test.ts` runs automatically. Then `start.bat` should report "worker + scheduler mode". |
| 3 | Bluesky App Password (optional) | Set `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD`. Then re-run the PoC; TC06 page 2 should pass. |
| 4 | Product Owner decisions | Listed in `docs/feasibility/README.md` §5:<br>- Bluesky policy proposal<br>- TikTok option (manual URL + oEmbed is recommended)<br>- Meta App Review<br>- paid sources (X, Apify) |
| 5 | Docker (optional) | `start.bat --docker` on a machine with Docker Desktop, to verify `docker-compose.yml`. |

## Next phase after closing the Phase 1 open items
**Phase 2** (Master Plan §16): YouTube and Bluesky live adapters at production level; TikTok and Meta as far as access allows. Deliverables: contract tests, real-data sync, usage and provenance.

## Environment notes for this machine
- Windows 11, Node 22.16, npm 10.9, Git, Python 3.12, .NET 8 SDK. **No Docker, WSL or Redis.**
- Local app data is in `.data/` (git-ignored): the embedded PostgreSQL on port 18968 and its random password in `.data/postgres.secret`.
- App URL: http://127.0.0.1:18966. Start with `start.bat`, stop with `stop.bat`.
- `git push` to `origin` (github.com/sonprovv/AutomationWorkflowSocial) works from this session.
- `cc-bot.bat` is user-local, contains personal account info, and is excluded via `.git/info/exclude`. Never commit it.
