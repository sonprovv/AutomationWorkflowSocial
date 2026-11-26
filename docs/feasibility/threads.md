# Feasibility: Threads (Threads API)

**Status: AUTH_REQUIRED.** Keyword search and profile discovery exist, but both are gated behind App Review.

| Field | Value |
|---|---|
| Checked | 2026-11-26 (desk research only, no API calls) |
| Capability record | [`capabilities/threads.json`](capabilities/threads.json) |

## Findings
- **`GET /keyword_search`** (source: https://developers.facebook.com/docs/threads/keyword-search)
  - Parameters:
    - `search_type`: TOP or RECENT.
    - `search_mode`: KEYWORD or TAG.
    - `since` and `until`.
    - `limit`: up to 100.
    - `author_username`.
  - Without **`threads_keyword_search`** approval, it searches only the authenticated user's own posts.
  - Limit: **2,200 queries per rolling 24 hours**.
- **`GET /profile_lookup?username=`** (source: https://developers.facebook.com/docs/threads/threads-profiles)
  - Needs **`threads_profile_discovery`**.
  - Only returns public profiles with **at least 100 followers**.
  - Standard access can only look up Meta's own accounts.
  - Limit: **1,000 requests per 24 hours**.
  - Returns follower, like, quote, repost and view counts.
- **Insights** are only available for the user's own posts. Whether we can get per-post metrics for *other* users' posts is **NOT VERIFIED**.

## What the user must provide
- A Threads app with Advanced Access to `threads_keyword_search` and `threads_profile_discovery`. Both require App Review.
- A Threads user OAuth token.

## Gate decision
⏳ **AUTH_REQUIRED.** Once access is approved, this is a good candidate after Bluesky and YouTube, because search and profile endpoints exist.
