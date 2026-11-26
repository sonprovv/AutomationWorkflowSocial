# ADR-0004: Restrictive default policy for YouTube

- **Status:** Accepted for the policy values. Enabling the adapter waits for live verification.
- **Date:** 2026-11-26
- **Phase:** 0

## Context
Under YouTube's Developer Policies (checked 2026-11-26), competitor channels are Non-Authorized Data. The policies set these limits:
- Data may be stored for at most 30 days, then refreshed or deleted (III.E.4.b and III.E.4.d).
- New or derived metrics are not allowed (III.E.4.h).
- Data from different content owners may not be aggregated (III.E.2.a).
- Audiovisual content may not be cached (III.E.1.a).

The III.L derived-metrics exception, in force since 2026-06-01, applies only to *audited* developers.

The quota docs now describe a separate search bucket of 100 calls per day. This conflicts with the older model, where each search cost 100 units.

## Decision
- Policy `youtube-nonauthorized-v0`:
  - `retentionDays=30` and `refreshDays=30`.
  - History, derived metrics, media processing and export are all set to **false**.
- WF07 viral scoring and cross-channel benchmarks are **disabled for YouTube** until a compliance audit and III.L approval are on record.
- AI analysis for YouTube uses metadata only.
- Quota accounting reserves the **upper bound** of 100 units per `search.list` call until a live key confirms the new model. Search calls are also counted separately in `searchCalls`.
- The API key is sent in a header, never as a `key=` query parameter.

## Consequences
- For YouTube, discovery, tracking and content listing still work, using current metrics only.
- Growth features for YouTube show "not available under YouTube API policy" in place of computed values.

## Alternatives considered
- Apply for a compliance audit and III.L approval. This is recommended in parallel, but it is slow and the outcome is not guaranteed.
