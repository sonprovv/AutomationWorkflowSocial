# ADR-0003: Collector core contract (typed errors, null instead of zero, provenance, deny-by-default)

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 0. Phase 1 P1-03 and Phase 2 build on this contract.

## Context
Master Plan §5 and §6.1 require:
- one shared adapter interface,
- typed errors,
- no invented or zero-filled data.

Phase 0 needs this contract so the PoC can run the same way on every platform.

## Decision
`@sss/collector-core` provides the pieces below.

### Adapter interface and canonical types
- **`PlatformAdapter`** is the §5.1 interface.
- The canonical types are `Account`, `Post`, `PostMetrics`, `Comment` and `Page<T>`.
- Every record carries `provenance`: `providerId`, `collectedAt`, `policyId`, `schemaVersion` and `source`.

### Errors and missing values
- **`CollectorError`** covers the 15 error codes in §5.3.
  - Only `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` and `TIMEOUT` are retryable.
  - A method the adapter does not support **throws `NOT_SUPPORTED`**. It never returns an empty array instead.
- **A missing value is `null` plus a `missing` reason**: `NOT_PROVIDED`, `HIDDEN_BY_OWNER`, `NOT_SUPPORTED` or `DISABLED`.
- `toCount()` never turns invalid input into 0.

### `HttpClient`
- Applies a timeout to each request and supports cancellation by the caller.
- Retries up to 3 times by default, with exponential backoff and jitter.
- Honours `Retry-After` and `RateLimit-Reset`. If the requested wait is longer than `maxRetryWaitMs`, it fails immediately.
- Allows HTTPS only, to hosts on an allowlist (SSRF guard), with `redirect: 'error'`.
- Logs every request with secrets redacted from the URL.

### `UsageMeter`
- A per-run guard: reserve first, then commit or release.
- Caps the number of requests, quota units and USD spent.
- The check happens *before* the network call, and reservations still in flight count toward the cap.
- This is the Phase 0 version of §9.1. The DB-backed atomic budget engine comes in Phase 4.

### Schema validation
- Response schemas use Zod loose objects, so extra fields are accepted.
- A missing required field raises `SCHEMA_CHANGED`.
- Invalid input raises `INVALID_INPUT`.

### Capability records
- The records in `docs/feasibility/capabilities/*.json` are validated by `capabilityRecordSchema`.
- A provider that is not VERIFIED cannot grant any data operation.
- A test fails if an adapter's `getCapabilities()` drifts away from its record.

### Secrets
- Secrets are read with `secretEnv()`, which registers each value for redaction.
- Secrets travel in headers, never in URLs. For YouTube this is the `X-Goog-Api-Key` header.
- Run reports pass through `redactDeep()` before they are written.

## Consequences
- Phase 1 reuses these types for the database schema: null means unknown, and provenance gets its own columns.
- Adding a platform only requires an adapter and a targets file. The PoC harness then runs on it unchanged.
