# PoC run summary — bluesky

Generated: 2026-11-26T15:24:25.289Z by `npm run poc:summary`. Source: the JSON run files in this folder (real provider calls, secrets redacted).

## Runs

| # | Started (UTC) | Label | Status | Credentials | Pass/Fail/Skip | Requests | Quota units | Cost USD | Req. success | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-26T08:27:21.565Z | run1 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 262 / 537 |
| 2 | 2026-11-26T08:34:04.952Z | run2 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 272 / 748 |
| 3 | 2026-11-26T15:23:44.435Z | run3 | COMPLETED_WITH_FAILURES | no | 24/3/1 | 36 | 0 | 0 | 88.9% | 610 / 1536 |

Time span covered: 6.94 h across 3 runs.

## Test cases across runs

| Test | Description | PASS | FAIL | SKIP | Error codes seen |
|---|---|---|---|---|---|
| TC01 | healthCheck | 3 | 0 | 0 |  |
| TC02a | validateCredentials (configured) | 3 | 0 | 0 |  |
| TC02b | validateCredentials (deliberately invalid) | 0 | 0 | 3 |  |
| TC03 | resolveAccount … | 15 | 0 | 0 |  |
| TC04 | resolveAccount nonexistent this-handle-should-not-exist-zz91.bsky.social | 3 | 0 | 0 | NOT_FOUND |
| TC05 | searchAccounts … | 9 | 0 | 0 |  |
| TC06.p1 | searchPosts … page 1 | 9 | 0 | 0 |  |
| TC06.p2 | searchPosts … page 2 | 0 | 9 | 0 | PERMISSION_DENIED |
| TC07 | getProfile + listPosts(20) bsky.app | 9 | 0 | 0 |  |
| TC08a | getPostDetail | 3 | 0 | 0 |  |
| TC08b | getPostMetrics batch (60) | 3 | 0 | 0 |  |
| TC09 | listComments (counts only, text not persisted) | 3 | 0 | 0 |  |
| TC10 | getPostDetail nonexistent post | 3 | 0 | 0 | NOT_FOUND |
| TC11 | cursor reuse (listPosts page 2 fetched twice) | 3 | 0 | 0 |  |
| TC12 | media URL expiry check (HEAD 5 URLs) | 3 | 0 | 0 |  |
| TC13 | field completeness | 3 | 0 | 0 |  |

## Requests (all runs)

- Total requests: 108; 2xx: 96
- Latency p50/p95/max: 290 / 1057 / 2391 ms
- Error codes: NOT_FOUND×3, PERMISSION_DENIED×9
- Quota units: 0; cost USD: 0

## ID stability across runs

- Account inputs resolved in ≥2 runs: 5; resolved to the same external ID every time: 5.
- did:plc:z72i7hdynmk6r22z27h6tvur: first vs last run post-ID overlap 20/20 (new posts or deletions explain differences; IDs themselves never changed format).
- did:plc:ewvi7nxzyoun6zhxrhs64oiz: first vs last run post-ID overlap 20/20 (new posts or deletions explain differences; IDs themselves never changed format).
- did:plc:eclio37ymobqex2ncko63h4r: first vs last run post-ID overlap 11/20 (new posts or deletions explain differences; IDs themselves never changed format).
