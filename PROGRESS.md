# PROGRESS — Social Spy Automation

Specification: [`SOCIAL_SPY_AUTOMATION_PLAN.md`](SOCIAL_SPY_AUTOMATION_PLAN.md). Architecture decisions: [`docs/adr/`](docs/adr/).

Status legend: ✅ done (with evidence) · 🟡 in progress or blocked on input · ⬜ not started

| Phase | Scope | Status |
|---|---|---|
| 0 | Data Source Feasibility | 🟡 **Code, tests and docs done. Gate blocked on `YOUTUBE_API_KEY`** (needs a second verified source) |
| 1 | Monorepo, Compose, DB, REST skeleton, queue, provider SDK | ⬜ (starts after the Phase 0 gate) |
| 2–9 | See Master Plan §16 | ⬜ |

---

## Phase 0 — Data Source Feasibility

**Started:** 2026-11-26 · **Spec:** Master Plan §4, sprint items P0-01…P0-05 (§16.1)

### Sprint items
| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-01 | Repo, ADR and capability matrix | ✅ | `docs/adr/0001…0006`; `docs/feasibility/capabilities/*.json` (10 platforms, schema-tested); `docs/feasibility/README.md` |
| P0-02 | YouTube PoC CLI with a user-supplied API key; policy check | 🟡 | Adapter and contract tests done ([youtube.md](docs/feasibility/youtube.md)). Policy reviewed (ADR-0004). Live classification of invalid and missing keys verified. **Waiting for `YOUTUBE_API_KEY`** to run the 3 live runs. |
| P0-03 | Bluesky PoC CLI; check public endpoints | ✅ | Live runs in `docs/feasibility/runs/bluesky/` and [`SUMMARY.md`](docs/feasibility/runs/bluesky/SUMMARY.md); [bluesky.md](docs/feasibility/bluesky.md) |
| P0-04 | Try TikTok/Meta legitimate sources; report blocked | ✅ | [tiktok.md](docs/feasibility/tiktok.md) (BLOCKED / LEGAL_RISK), [facebook.md](docs/feasibility/facebook.md), [instagram.md](docs/feasibility/instagram.md), [threads.md](docs/feasibility/threads.md) (AUTH_REQUIRED) and ADR-0006. No credentials were available, so these are desk research only. |
| P0-05 | Save test results, cost, fields, sample payloads, source links, check dates | ✅ | `runs/*/*.json` (redacted), `samples/*.sample.json`, cost estimate in `docs/feasibility/README.md` §3, sources with dates in every capability record |

### Deliverables
- `packages/collectors/core`
  - Typed errors (§5.3) and canonical types plus the `PlatformAdapter` contract (§5.1).
  - `HttpClient`: timeout, backoff with jitter, Retry-After handling, SSRF allowlist, redacted logs.
  - `UsageMeter`: request, quota and cost caps.
  - Zod response and input validation, and the capability record schema.
- `packages/collectors/bluesky`: adapter implementing all 8 capabilities, with optional App Password authentication.
- `packages/collectors/youtube`: adapter implementing all 8 capabilities. The API key travels in a header, and quota is reserved at the upper bound.
- `tools/feasibility`
  - `npm run poc -- <platform>` runs the §4.2 test cases TC01–TC13 against the real API and writes a redacted run report plus a normalized sample.
  - `npm run poc:summary` aggregates runs: latency, error codes, and ID stability across runs.
- `docs/feasibility/`: a report per platform for all 10 platforms in the §4.1 matrix, plus `_research/` notes that quote the official documentation.

### Test evidence (2026-11-26, Windows 11, Node 22.16.0)
- `npm run typecheck`: clean.
- `npm test`: **74 passed**, 4 files.
  - Unit tests.
  - Contract tests against a local fake HTTP server, with no network.
  - A schema check on the capability records.
  - A drift check between each adapter and its capability record.
- `npm run test:live`: Bluesky live smoke **3 passed**. YouTube is skipped because no key is configured.
- `npm run poc -- bluesky`: 24 PASS / 3 FAIL / 1 SKIP in each run.
  - The 3 FAILs are a **real platform limitation**: unauthenticated search pagination returns HTTP 403. See ADR-0005.
  - The SKIP is the negative credential test, which needs an App Password.
  - The full run history is in `runs/bluesky/SUMMARY.md`.
- `npm run poc -- youtube`: `AUTH_REQUIRED`. Credential checks ran; the invalid key was classified live as `INVALID`.

### Technical limitations found (with proposed solutions)
| Limitation | Proposed solution |
|---|---|
| Bluesky: no view counts | Engagement-only metrics, labelled as such. `views=null` with reason `NOT_SUPPORTED`. |
| Bluesky: unauthenticated search is limited to page 1 (≤100 results) | Narrower time windows, or the user supplies an App Password (ADR-0005). |
| YouTube: 30-day retention; no derived metrics or cross-owner aggregation without III.L approval | Restrictive policy (ADR-0004). Apply for an audit and III.L approval in parallel. |
| YouTube: search capped at about 100 calls per day | Spend searches on discovery only; use cheap list calls for monitoring. |
| TikTok: no commercial official API; scraping conflicts with the ToS | BLOCKED. Interim option: manual URL plus oEmbed metadata. A scraper only with written acceptance of the legal risk (ADR-0006). |
| Facebook, Instagram, Threads: App Review and Business Verification required | User action needed. The adapters will be built once access is granted. |
| Reddit: official terms pages blocked our automated fetch | Manual verification in a browser. |
| macOS: not tested yet (Windows only) | The commands are cross-platform (npm, tsx). To be verified on a Mac; start/stop scripts come in Phase 1. |

### Open items blocking the Phase 0 gate
1. 🟡 **User:** add `YOUTUBE_API_KEY` to `.env`, then run `npm run poc -- youtube` three times at different times, then `npm run poc:summary`.
2. 🟡 **Product Owner:** the decisions listed in [docs/feasibility/README.md §5](docs/feasibility/README.md).
3. 🟡 **Git push to GitHub:** blocked by the permission policy in this session. The user has to enable it from the terminal. Commits are made locally.

### Log
- 2026-11-26 08:11 UTC: Phase 0 started. Spec read. Toolchain checked: Node 22.16, npm 10.9, Git, Python 3.12. Docker is not installed (needed in Phase 1).
- 2026-11-26 08:20: collector core and the Bluesky and YouTube adapters written. Official-documentation research completed for all 10 platforms.
- 2026-11-26 08:27: Bluesky PoC run 1 against the live API.
- 2026-11-26 08:28: YouTube PoC run 1. Credential checks only (no key).
- 2026-11-26 08:34: Bluesky PoC run 2.
- 2026-11-26 ~08:40: capability records, feasibility reports, ADRs 0001–0006 and this file written.
- Scheduled: Bluesky run 3 at about 10:13 UTC (17:13 Asia/Ho_Chi_Minh), plus the YouTube runs if a key has been added by then.
