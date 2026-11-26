# Collector SDK specification

Contract: Master Plan §5. The decision record is [ADR-0003](adr/0003-collector-core-contract.md).

## Adapter contract
`PlatformAdapter` lives in `packages/collectors/core/src/types.ts` and has these methods:

| Group | Methods |
|---|---|
| Status | `getCapabilities`, `validateCredentials`, `healthCheck` |
| Accounts | `resolveAccount`, `searchAccounts`, `getProfile` |
| Posts | `searchPosts`, `listPosts`, `getPostDetail`, `getPostMetrics` |
| Comments | `listComments` |

Rules every adapter follows:
- **Typed errors.** Every failure is a `CollectorError` carrying one of the 15 codes in §5.3. An unsupported method throws `NOT_SUPPORTED`; it never returns an empty list.
- **Missing data is `null`.** Missing values are `null` and the reason goes in `missing`. Counters are parsed with `toCount()`.
- **Provenance on every record.** Each record carries `providerId`, `collectedAt`, `policyId`, `schemaVersion` and `source`.
- **HTTP goes through `HttpClient`**, which provides:
  - timeouts and cancellation;
  - retries with backoff and jitter for transient errors only;
  - `Retry-After` and `RateLimit-Reset` handling;
  - an HTTPS host allowlist;
  - redacted request logs;
  - a `UsageMeter` reservation before each call.
- **Response validation.** Responses are checked with zod loose schemas. If a required field disappears, the adapter raises `SCHEMA_CHANGED`.
- **Secrets stay out of URLs.** Secrets are sent in headers and registered with `globalSecrets` so they are redacted.

## Adding a platform
1. Create `packages/collectors/<platform>`: `schemas.ts`, `normalize.ts`, `adapter.ts`, and contract tests that run against `startFakeServer`.
2. Add `tools/feasibility/targets/<platform>.json`, then run `npm run poc -- <platform>` three or more times. Write `docs/feasibility/<platform>.md` and update `capabilities/<platform>.json`. This is the Phase 0 gate for the platform.
3. Register a descriptor in `packages/collectors/registry`: provider ID, platform, credential reference, usage unit and daily cap.
4. The seed enables the provider only when its record is `VERIFIED`.

## Implemented adapters

| Provider | Status | Notes |
|---|---|---|
| `bluesky-appview` | VERIFIED, enabled | See `docs/feasibility/bluesky.md` |
| `youtube-data-api-v3` | AUTH_REQUIRED, disabled until a key is added and verified | See `docs/feasibility/youtube.md` |
