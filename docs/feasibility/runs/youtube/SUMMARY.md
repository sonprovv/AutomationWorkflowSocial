# PoC run summary — youtube

Generated: 2026-11-26T08:28:49.407Z by `npm run poc:summary`. Source: the JSON run files in this folder (real provider calls, secrets redacted).

## Runs

| # | Started (UTC) | Label | Status | Credentials | Pass/Fail/Skip | Requests | Quota units | Cost USD | Req. success | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-26T08:28:14.979Z | run1 | AUTH_REQUIRED | no | 1/0/1 | 1 | 1 | 0 | 0.0% | 317 / 317 |

## Test cases across runs

| Test | Description | PASS | FAIL | SKIP | Error codes seen |
|---|---|---|---|---|---|
| TC02a | validateCredentials (configured) | 0 | 0 | 1 |  |
| TC02b | validateCredentials (deliberately invalid) is classified | 1 | 0 | 0 |  |

## Requests (all runs)

- Total requests: 1; 2xx: 0
- Latency p50/p95/max: 317 / 317 / 317 ms
- Error codes: AUTH_REQUIRED×1
- Quota units: 1; cost USD: 0

## ID stability across runs

- Account inputs resolved in ≥2 runs: 0; resolved to the same external ID every time: 0.

> Only 1 run(s) so far. Master Plan §4.2 asks for at least 3 runs at different times.
