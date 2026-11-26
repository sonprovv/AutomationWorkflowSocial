# PoC run summary — bluesky

Generated: 2026-11-26T08:36:56.084Z by `npm run poc:summary`. Source: the JSON run files in this folder (real provider calls, secrets redacted).

## Runs

| # | Started (UTC) | Label | Status | Credentials | Pass/Fail/Skip | Requests | Quota units | Cost USD | Req. success | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-26T08:27:21.565Z | run1 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 262 / 537 |
| 2 | 2026-11-26T08:34:04.952Z | run2 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 272 / 748 |

Time span covered: 0.11 h across 2 runs.

## Test cases across runs

| Test | Description | PASS | FAIL | SKIP | Error codes seen |
|---|---|---|---|---|---|
| TC01 | healthCheck | 2 | 0 | 0 |  |
| TC02a | validateCredentials (configured) | 2 | 0 | 0 |  |
| TC02b | validateCredentials (deliberately invalid) | 0 | 0 | 2 |  |
| TC03 | resolveAccount … | 10 | 0 | 0 |  |
| TC04 | resolveAccount nonexistent this-handle-should-not-exist-zz91.bsky.social | 2 | 0 | 0 | NOT_FOUND |
| TC05 | searchAccounts … | 6 | 0 | 0 |  |
| TC06.p1 | searchPosts … page 1 | 6 | 0 | 0 |  |
| TC06.p2 | searchPosts … page 2 | 0 | 6 | 0 | PERMISSION_DENIED |
| TC07 | getProfile + listPosts(20) bsky.app | 6 | 0 | 0 |  |
| TC08a | getPostDetail | 2 | 0 | 0 |  |
| TC08b | getPostMetrics batch (60) | 2 | 0 | 0 |  |
| TC09 | listComments (counts only, text not persisted) | 2 | 0 | 0 |  |
| TC10 | getPostDetail nonexistent post | 2 | 0 | 0 | NOT_FOUND |
| TC11 | cursor reuse (listPosts page 2 fetched twice) | 2 | 0 | 0 |  |
| TC12 | media URL expiry check (HEAD 5 URLs) | 2 | 0 | 0 |  |
| TC13 | field completeness | 2 | 0 | 0 |  |

## Requests (all runs)

- Total requests: 72; 2xx: 64
- Latency p50/p95/max: 267 / 537 / 1087 ms
- Error codes: NOT_FOUND×2, PERMISSION_DENIED×6
- Quota units: 0; cost USD: 0

## ID stability across runs

- Account inputs resolved in ≥2 runs: 5; resolved to the same external ID every time: 5.
- did:plc:z72i7hdynmk6r22z27h6tvur: first vs last run post-ID overlap 20/20 (new posts or deletions explain differences; IDs themselves never changed format).
- did:plc:ewvi7nxzyoun6zhxrhs64oiz: first vs last run post-ID overlap 20/20 (new posts or deletions explain differences; IDs themselves never changed format).
- did:plc:eclio37ymobqex2ncko63h4r: first vs last run post-ID overlap 20/20 (new posts or deletions explain differences; IDs themselves never changed format).

> Only 2 run(s) so far. Master Plan §4.2 asks for at least 3 runs at different times.
