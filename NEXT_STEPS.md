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

## Next phase after closing the Phase 1 open items
**Phase 2** (Master Plan §16): YouTube and Bluesky live adapters at production level; TikTok and Meta as far as access allows. Deliverables: contract tests, real-data sync, usage and provenance.

## Environment notes for this machine
- Windows 11, Node 22.16, npm 10.9, Git, Python 3.12, .NET 8 SDK. **No Docker, WSL or Redis.**
- Local app data is in `.data/` (git-ignored): the embedded PostgreSQL on port 18968 and its random password in `.data/postgres.secret`.
- App URL: http://127.0.0.1:18966. Start with `start.bat`, stop with `stop.bat`.
- `git push` to `origin` (github.com/sonprovv/AutomationWorkflowSocial) works from this session.
- `cc-bot.bat` is user-local, contains personal account info, and is excluded via `.git/info/exclude`. Never commit it.
