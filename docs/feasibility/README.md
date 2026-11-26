# Phase 0: Data Source Feasibility report

**Date:** 2026-11-26 · **Spec:** Master Plan §4 · **Harness:** `tools/feasibility` (`npm run poc -- <platform>`)

This report covers every platform in the Master Plan §4.1 matrix. Only Bluesky was verified with live calls. YouTube is waiting for an API key, and the other eight platforms are desk research from official documentation.

## 1. Matrix

| Platform | Status | Evidence | Credential needed to progress | MVP decision |
|---|---|---|---|---|
| **Bluesky** | ✅ **VERIFIED** | 3 live PoC runs over about 7 h: [runs/bluesky](runs/bluesky/SUMMARY.md) | None. An App Password is optional and only needed for search pagination | **Production adapter #1** |
| **YouTube** | ⏳ AUTH_REQUIRED | Adapter + contract tests. Live key handling verified with an invalid key | `YOUTUBE_API_KEY` | **Production adapter #2**, once 3 live runs pass |
| TikTok | ❌ BLOCKED | Official docs + ToS | No official commercial path. Apify = LEGAL_RISK | Not enabled. Alternatives are in [tiktok.md](tiktok.md) |
| Facebook | ⏳ AUTH_REQUIRED | Official docs | Meta app + Business Verification + PPCA App Review | After MVP, if approved |
| Instagram | ⏳ AUTH_REQUIRED | Official docs | IG Business account + Meta app Advanced Access | After MVP, if approved |
| Threads | ⏳ AUTH_REQUIRED | Official docs | `threads_keyword_search` + `threads_profile_discovery` App Review | Best candidate after the MVP |
| Reddit | ❔ UNVERIFIED | Official pages blocked our fetcher (HTTP 403) | OAuth client, plus likely a commercial agreement | Needs a manual terms check |
| X | ⏳ AUTH_REQUIRED (paid) | Official docs | Bearer token + prepaid credits (~$150/month for the pilot) | Optional, budget decision |
| Pinterest | ⏳ AUTH_REQUIRED / LIMITED | Official docs (partly unverified) | Standard-tier app + beta search approval | Later |
| LinkedIn | ❌ BLOCKED (competitor posts) | Official docs | Community Management API app | Follower counts at most |

Machine-readable records are in [`capabilities/*.json`](capabilities/). They are schema-validated by `npm test`, and the test fails if an adapter's `getCapabilities()` no longer matches its record.

### App stores (App Spy, Phase 9: separate records in [`app-stores/`](app-stores/))

| Store | Status | Evidence | Credential | Decision |
|---|---|---|---|---|
| **Apple App Store** (iTunes Search/Lookup API) | ✅ **VERIFIED** (data policy pending the Product Owner) | 2 live PoC runs, 8 PASS / 2 PARTIAL each: [apple-app-store.md](apple-app-store.md) | None | App Spy: track apps, developer apps, website → social links with evidence. Latest listing only, no export, no icons |
| Google Play | ❌ BLOCKED | Official docs: no public catalogue API ([google-play-apps.md](google-play-apps.md)) | — | iOS only, unless the Product Owner buys a licensed data feed |

### Ad libraries (Ad Spy, P9-04: desk research only, records in [`ad-sources/`](ad-sources/), report [ad-spy.md](ad-spy.md))

| Source | Status | Coverage | Spend |
|---|---|---|---|
| Meta Ad Library API | ⏳ AUTH_REQUIRED (identity confirmation) | EU-delivered ads; political/issue ads worldwide | Ranges, political/issue ads only |
| Google Ads Transparency Center | ❌ BLOCKED (no API; a BigQuery dataset is reported, unverified) | — | None |
| TikTok Commercial Content API | ⚠ LEGAL_RISK (research-purpose terms) | EU/EEA ads only | None |

Spend, revenue and ROAS are never inferred.

## 2. Gate status (Master Plan §4.3 / §16: "at least 2 sources verified")

- [x] Test harness with typed errors, quota/budget guard, redaction and contract tests (74 unit/contract tests, 3 live smoke tests).
- [x] Source 1: **Bluesky** verified with real data. See [bluesky.md](bluesky.md).
- [ ] Source 2: **YouTube**. Blocked on `YOUTUBE_API_KEY` (user action, [youtube.md §5](youtube.md)).
- [x] Blocked and auth-required sources reported with a reason and an alternative.
- [x] Policy matrix with sources and check dates. Effective policies are deny-by-default.
- [ ] Product Owner decisions (§5 below).

**Phase 0 is NOT closed** until YouTube passes 3 live runs, or the Product Owner picks a different second source.

## 3. Cost estimate for the pilot (50 accounts, 20 posts each, Master Plan §17.3)

| Source | Monetary cost | Quota usage | Binding constraint |
|---|---|---|---|
| Bluesky | $0 | ~1,600 requests/day | Unauthenticated search: page 1 only (≤100 results per query) |
| YouTube | $0 | ~1,700 units/day + ~20 searches (default quota: 10,000 units, 100 searches/day) | Search calls; 30-day storage rule |
| X (optional) | ~$150/month | 30k post reads/month | Budget |
| TikTok via Apify (not enabled) | ~$51/month at $1.70 per 1,000 results × 30k | — | **Legal risk**, not cost |

These figures do not include AI analysis (Phase 6) or infrastructure (local Docker, $0).

## 4. Effects on later phases (carry-over requirements)

1. **YouTube:** WF07 (viral score), metric history and cross-channel benchmarks stay **off**. Retention is 30 days, with refresh or delete. No media processing. YouTube attribution is required in the UI and in exports.
2. **Bluesky:** no `views` metric. Viral scoring must be engagement-only and say so. Deletions must propagate (Developer Guidelines).
3. **Search coverage UX** (Master Plan §7.3) must show "Bluesky search limited to first page without App Password", and must show TikTok, Meta and others as `BLOCKED` / `AUTH_REQUIRED` with the reason.
4. **The policy engine** (Phase 4) loads `capabilities/*.json` as its initial `data_policies`.

## 5. Decisions needed from the Product Owner

1. Supply `YOUTUBE_API_KEY`. This is required to close Phase 0.
2. Optional: a Bluesky App Password, to enable search pagination.
3. Approve or reject the **Bluesky policy proposal** (store snapshots and derived metrics, 30-day refresh/deletion check, 365-day retention, export with source URLs).
4. TikTok: choose manual URL/oEmbed import (recommended), Display API for owned accounts only, or accept the legal risk of a scraper in writing.
5. Meta (FB/IG/Threads): decide whether to start Business Verification and App Review now. It takes weeks.
6. Paid sources (X, Apify): accept or reject the budget.

## 6. How to reproduce

```bash
npm ci
cp .env.example .env            # Windows: copy .env.example .env
npm test                        # unit + contract tests (no network)
npm run poc -- bluesky          # live PoC run (no credentials needed)
npm run poc -- youtube          # live PoC run (needs YOUTUBE_API_KEY)
npm run poc:summary             # regenerate runs/<platform>/SUMMARY.md
npm run test:live               # opt-in live smoke tests
```
