# ADR-0005: Bluesky search uses unauthenticated page 1; an App Password unlocks pagination

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 0

## Context
PoC runs on 2026-11-26 showed the following for `app.bsky.feed.searchPosts`:
- `public.api.bsky.app`, the documented public host, returned **403**.
- `api.bsky.app` without authentication returned **200** for page 1.
- `api.bsky.app` without authentication returned **403** ("Request forbidden by administrative rules") for any request that included a `cursor`.

The API documentation says searchPosts "may require authentication".

## Decision
- **Without credentials:**
  - `searchPosts` calls `api.bsky.app` for page 1 and adds a warning that this path is undocumented.
  - If a request for a later page gets a 403, the adapter raises `PERMISSION_DENIED` with `providerReason=UNAUTH_SEARCH_PAGINATION_BLOCKED` and an actionable message.
  - The capability is **PARTIAL**.
- **With `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` set:**
  - Search follows the documented authenticated path: `createSession` on bsky.social, then requests with the header `atproto-proxy: did:web:api.bsky.app#bsky_appview`.
  - The capability is SUPPORTED, pending a live run with the user's App Password.
- All other reads go to `public.api.bsky.app` without authentication.
- We never use multiple accounts or IPs to get around limits (Master Plan §5.3).

## Consequences
- Without an App Password, discovery returns at most 100 posts per query. WF02 should narrow its time windows (`since`/`until`) and sort by latest instead of paginating.
