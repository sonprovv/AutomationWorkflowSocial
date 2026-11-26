# Feasibility: Bluesky (AT Protocol)

**Verdict: VERIFIED. We can use it for the MVP. Two capabilities are PARTIAL (see below).**

| Field | Value |
|---|---|
| Checked | 2026-11-26 |
| Provider | `bluesky-appview` (public AppView, `packages/collectors/bluesky`) |
| Capability record | [`capabilities/bluesky.json`](capabilities/bluesky.json) |
| Run evidence | [`runs/bluesky/`](runs/bluesky/) (JSON per run, secrets redacted), aggregated in [`runs/bluesky/SUMMARY.md`](runs/bluesky/SUMMARY.md) |
| Sample | [`samples/bluesky.sample.json`](samples/bluesky.sample.json) (real normalized records, truncated) |
| Credentials | None required. An App Password is optional and needed only to page through search results |
| Cost | $0. Public API with no published price |

## 1. Endpoints used

| Capability | Endpoint | Host | Status |
|---|---|---|---|
| healthCheck | `/xrpc/_health` | public.api.bsky.app | SUPPORTED |
| resolveAccount / getProfile | `app.bsky.actor.getProfile` (accepts a handle or DID) | public.api.bsky.app | SUPPORTED |
| searchAccounts | `app.bsky.actor.searchActors` | public.api.bsky.app | SUPPORTED |
| searchPosts | `app.bsky.feed.searchPosts` | api.bsky.app without auth, or PDS + `atproto-proxy` with an App Password | **PARTIAL** |
| listPosts | `app.bsky.feed.getAuthorFeed?filter=posts_no_replies` | public.api.bsky.app | SUPPORTED |
| getPostDetail / getPostMetrics | `app.bsky.feed.getPosts` (25 URIs per batch) | public.api.bsky.app | SUPPORTED |
| listComments | `app.bsky.feed.getPostThread?depth=1` | public.api.bsky.app | **PARTIAL** |

**Stable IDs:**
- An account is identified by its **DID** (`did:plc:…`). Handles can change, DIDs do not.
- A post is identified by its **AT URI** (`at://<did>/app.bsky.feed.post/<rkey>`).

## 2. Results of the §4.2 test cases (real calls)

These are run 1 figures (2026-11-26 08:27 UTC). Runs 2 (08:34 UTC) and 3 (15:23 UTC) gave the same results: 24 PASS, 3 FAIL (search page 2, HTTP 403), 1 SKIP, about 7 hours apart. Run 3 latency was higher (p50 610 ms, p95 1536 ms), still with no 429s. See `runs/bluesky/SUMMARY.md`.

| Test case | Result |
|---|---|
| Validate credentials | `NOT_REQUIRED` for public reads. The wrong-App-Password path (`INVALID`) is covered by a contract test. The live negative test only runs once an App Password is configured. |
| Resolve 3–5 URLs/handles | 5/5. A URL, `@handle`, bare DID and bare domain handle all resolve. `bsky.app` and its DID resolve to the same DID. |
| Nonexistent account | Typed `NOT_FOUND` (XRPC `InvalidRequest` "Profile not found"). We never return an empty result instead. |
| Search accounts, 3 keywords | 3/3, 25 results each, with a cursor. ⚠ No language or region filter, and no follower counts (we enrich these with getProfile). |
| Search posts, 3 keywords, page 1 | 3/3, 25 results each. The `lang=en` filter works: 25 of 25 results were `en`. |
| Search posts, page 2 (cursor) | **0/3. HTTP 403 "Request forbidden by administrative rules"** when unauthenticated. We confirmed this separately with curl: page 1 returns 200, and any request with a `cursor` returns 403. `limit=100` on page 1 works. |
| Profile + 20 posts × 3 accounts | 3/3. Reposts by other people are filtered out (on @bsky.app, 40 reposts were skipped to collect 20 own posts, over 4 pages). |
| Post detail and batched metrics | 60 of 60 returned. likes, replies, reposts and bookmarks were present on 100%. **views were null on 100%** (the platform has no view count). |
| Comments | 20 top-level replies. There is no cursor (depth=1). Comment text is not stored in run logs. |
| Removed or nonexistent post | Typed `NOT_FOUND` (`getPosts` silently leaves it out, and the adapter turns that into an error). |
| Cursor reuse | Reusable: the same cursor fetched twice returned the same page. |
| Media URLs | 5 of 5 CDN images returned 200. They are **unsigned** and `cache-control: public, max-age=604800` (7 days). They are content-addressed (CID), so they stay stable while the blob exists. |
| Latency | p50 262 ms, p95 537 ms, max 723 ms over 36 requests. No 429 and no retries. |
| Field completeness (131 posts) | caption 100%; publishedAt 100%; language 85.5%; thumbnail 70.2%; hashtags 30.5%; duration 0% (not exposed); title 0% (not a platform concept) |

## 3. Limitations and how we handle them

1. **No view count.** `views` stays `null` and `missing.views = NOT_SUPPORTED`. Viral scoring has to use engagement only and say so.
2. **Search pagination needs authentication.** Without an App Password we get at most 100 posts per keyword per query (page 1). We have two options:
   - **(a) Default.** Run more narrowly scoped queries using `since`/`until` windows and `sort=latest` together with `lang`. Each query's page 1 stays within the limit.
   - **(b)** The user creates a Bluesky **App Password** (Settings → App Passwords, never the main password) and sets `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD`. The adapter then calls through the documented authenticated path (`createSession` + `atproto-proxy`). Mapping that path's errors is covered by contract tests. **The live pagination test is pending until the user provides an App Password.**
3. **Unauthenticated search on `api.bsky.app` is undocumented.** The documented public host `public.api.bsky.app` rejects searchPosts with 403. Because of this:
   - The adapter adds a warning to every unauthenticated search page.
   - `getCapabilities()` reports `PARTIAL`.
   - If Bluesky changes this, the adapter raises a typed error. It will not silently return 0 results.
4. **`createdAt` is supplied by the author** and can be backdated. `indexedAt` is the server time. We store both from Phase 2 onwards.
5. **There is no country or market data.** We do not infer it, as Master Plan §10.1 requires.
6. **Comments:** only top-level replies, with no pagination. Storing comments is denied by policy by default.

## 4. Policy (sources and decision)

- **Developer Guidelines:**
  - "All services must have a method for deleting content a user has requested to be deleted."
  - No spam and no automated interactions. **Our system is read-only and never posts or interacts.**
  - Source: https://bsky.network/docs/developer-guidelines
- **atproto account spec:** content from deleted or deactivated accounts *should not* be redistributed. Source: https://atproto.com/specs/account
- **Terms of Service (2025-08-14):** third-party apps are governed by their own terms. They say nothing about storing data, derived metrics or AI. Source: https://bsky.social/about/support/tos
- **Effective policy (`bluesky-public-v0-unverified`):** deny-by-default. History, derived metrics, media and export are all `false` until the Product Owner approves `policyProposal`.
- **Proposed (pending approval):**
  - Store public metadata and counts, with a refresh/deletion check every 30 days and a 365-day retention limit.
  - Allow derived metrics.
  - Allow internal export with source URLs.
  - Do not store media.
  - Do not store comment text.
- **Rate limits:** the AppView publishes no numbers. The PDS allows 3000 requests per 5 minutes per IP, and `createSession` allows 30 per 5 minutes and 300 per day. The adapter honors `Retry-After` and `RateLimit-Reset`.

## 5. Cost estimate for the pilot (Master Plan §17.3)

There is no monetary cost. Request volume for 50 accounts:

| Job | Requests |
|---|---|
| Sync every 2 h | about 50 `getAuthorFeed` calls → 600 per day |
| Metrics refresh for 1,000 posts every hour | 40 `getPosts` batches → 960 per day |
| Discovery: 20 keywords per day | 20 per day |

That totals about **1,600 requests per day**, roughly 1 request per minute, well inside the per-IP PDS limit.

## 6. Gate decision

✅ **Bluesky passes the Phase 0 gate as a production source.** The capabilities are verified with real data. The cost is $0 and predictable. No unauthorized access is needed.

Data storage beyond the current snapshot stays **disabled** until the Product Owner approves the policy proposal.
