# PoC run summary — bluesky

Generated: 2026-11-26T08:28:49.380Z by `npm run poc:summary`. Source: the JSON run files in this folder (real provider calls, secrets redacted).

## Runs

| # | Started (UTC) | Label | Status | Credentials | Pass/Fail/Skip | Requests | Quota units | Cost USD | Req. success | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-26T08:27:21.565Z | run1 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 262 / 537 |

## Test cases across runs

| Test | Description | PASS | FAIL | SKIP | Error codes seen |
|---|---|---|---|---|---|
| TC01 | healthCheck | 1 | 0 | 0 |  |
| TC02a | validateCredentials (configured) | 1 | 0 | 0 |  |
| TC02b | validateCredentials (deliberately invalid) | 0 | 0 | 1 |  |
| TC03 | resolveAccount … | 5 | 0 | 0 |  |
| TC04 | resolveAccount nonexistent this-handle-should-not-exist-zz91.bsky.social | 1 | 0 | 0 | NOT_FOUND |
| TC05 | searchAccounts … | 3 | 0 | 0 |  |
| TC06.p1 | searchPosts … page 1 | 3 | 0 | 0 |  |
| TC06.p2 | searchPosts … page 2 | 0 | 3 | 0 | PERMISSION_DENIED |
| TC07 | getProfile + listPosts(20) bsky.app | 3 | 0 | 0 |  |
| TC08a | getPostDetail | 1 | 0 | 0 |  |
| TC08b | getPostMetrics batch (60) | 1 | 0 | 0 |  |
| TC09 | listComments (counts only, text not persisted) | 1 | 0 | 0 |  |
| TC10 | getPostDetail nonexistent post | 1 | 0 | 0 | NOT_FOUND |
| TC11 | cursor reuse (listPosts page 2 fetched twice) | 1 | 0 | 0 |  |
| TC12 | media URL expiry check (HEAD 5 URLs) | 1 | 0 | 0 |  |
| TC13 | field completeness | 1 | 0 | 0 |  |

## Requests (all runs)

- Total requests: 36; 2xx: 32
- Latency p50/p95/max: 262 / 537 / 723 ms
- Error codes: NOT_FOUND×1, PERMISSION_DENIED×3
- Quota units: 0; cost USD: 0

## ID stability across runs

- Account inputs resolved in ≥2 runs: 0; resolved to the same external ID every time: 0.

> Only 1 run(s) so far. Master Plan §4.2 asks for at least 3 runs at different times.
