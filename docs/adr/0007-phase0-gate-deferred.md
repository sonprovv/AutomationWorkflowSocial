# ADR-0007: Start Phase 1 while the Phase 0 gate waits on the YouTube key

- **Status:** Accepted (decision by the Product Owner)
- **Date:** 2026-11-26
- **Phase:** 0 → 1

## Context
The Phase 0 gate (Master Plan §16) requires at least 2 sources verified with real data. Bluesky is verified. YouTube is blocked only because no API key has been provided. On 2026-11-26 the Product Owner said: "ok cứ làm tiếp đi. các key để cuối cùng tôi thêm sau" ("OK, keep going. I'll add the keys at the end").

## Decision
- Phase 1 (the platform skeleton) starts now.
- The Phase 0 gate stays **open, not passed**. It is not waived. `PROGRESS.md` tracks it as "pending YouTube key".
- The YouTube adapter stays **disabled**: `providers.enabled=false` because its capability record status is `AUTH_REQUIRED`. Production enablement still requires the 3 live PoC runs and a record update.
- Phase 1 work is designed to be independent of which second provider ends up verified.

## Consequences
- No production feature relies on YouTube until the key is added and verified.
- When the key arrives:
  1. Run `npm run poc -- youtube` three times.
  2. Run `npm run poc:summary`.
  3. Update `docs/feasibility/capabilities/youtube.json` to `VERIFIED`.
  4. Restart. The seed enables the provider automatically.
