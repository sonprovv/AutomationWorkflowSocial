# Review of official YouTube Data API v3 and Bluesky/AT Protocol documentation

- **Review date:** 2026-11-26
- **Method:** an AI research agent read the official documentation. This note quotes short excerpts with their URLs.
- **Before relying on any policy wording for legal or compliance purposes, a person must re-read the source page.**
- **Redirects:** docs.bsky.app now answers with a 308 redirect to `bsky.network/docs/...`, and its endpoint reference redirects to `endpoints.bsky.app`. Both redirects are served by Bluesky's own servers.

## YouTube Data API v3

### Quota
- **Default allocation:** "a default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints." Sources: https://developers.google.com/youtube/v3/determine_quota_cost and https://developers.google.com/youtube/v3/getting-started
- **search.list cost:** 1 unit, charged to a separate "Search Queries" bucket capped at 100 calls per day. Source: https://developers.google.com/youtube/v3/docs/search/list
  - ⚠ This differs from the older model of 100 units per search, which the Master Plan assumed. It must be confirmed empirically with a real key.
- **Other read calls:** channels.list, videos.list, playlistItems.list and commentThreads.list each cost 1 unit.
- **Failed requests:** "All API requests, including invalid requests, incur a quota cost of at least one point."
- **Reset:** "Daily quotas reset at midnight Pacific Time (PT)."
- **Getting more quota:** complete the Audit and Quota Extension Form at https://support.google.com/youtube/contact/yt_api_form after a compliance audit. Source: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits

### Error reasons
Source: https://developers.google.com/youtube/v3/docs/core_errors

| Reason | HTTP status |
|---|---|
| `keyInvalid` | 400 |
| `keyExpired` | 400 |
| `quotaExceeded` | 403 |
| `dailyLimitExceeded` | 403 |
| `accessNotConfigured` (API not enabled) | 403 |
| `forbidden` | 403 |
| `rateLimitExceeded` | 403 or 429 |
| `userRateLimitExceeded` | 403 |
| `limitExceeded` | 403 |

Key-restriction reasons such as `API_KEY_HTTP_REFERRER_BLOCKED` are not documented on those pages. The adapter also inspects `error.details[].reason` (google.rpc.ErrorInfo).

### Developer Policies
Source: https://developers.google.com/youtube/terms/developer-policies

- **Storage limits**
  - **III.E.4.c, Authorized Data:** keep it "no longer than 30 calendar days", then delete or refresh it.
  - **III.E.4.d, Non-Authorized Data** (data obtained without user credentials, which is all competitor data): "temporarily store limited amounts … for as long as is necessary", up to 30 days, then delete or refresh it.
  - **III.E.4.b:** "an API Client must not store statistics retrieved as Non-Authorized Data for more than 30 days."
  - **III.E.4.f:** show the most up-to-date data. Historical data is acceptable when it is "presented accurately in context of time".
- **Analysis limits**
  - **III.E.4.h:** do not "access or use API Data to create new or derived data or metrics", and do not replace API data with independently calculated data.
  - **III.L exception (from 2026-06-01):** applies to audited developers with analytics use cases. Source: https://developers.google.com/youtube/terms/derived-metrics-policy
    - Permits derived metrics such as average views, growth rate and engagement ratio.
    - Permits storing statistics for up to 36 months. Titles, descriptions and comments still follow the 30-day rule.
    - Permits ranking or tracking views across channels for comparison.
    - The page does not say whether the exception applies to Non-Authorized Data.
  - **III.E.2.a:** "Do not aggregate API Data except … channels that are under the same content owner". This conflicts with cross-channel benchmarking unless the III.L approval applies.
  - **III.E.2.b:** do not use the data to gain insight into YouTube's own usage or revenue.
  - **III.I.1:** do not build a substitute for YouTube applications.
- **Data handling**
  - **Deletion:** delete within 7 days of a user request (III.E.4.g) or within 7 days of revocation (III.D.2).
  - **Attribution, III.F.2:** make clear that YouTube is the source.
  - **Media:**
    - III.E.1.a: do not download, cache or store audiovisual content without written approval.
    - III.I.7: do not separate audio from video.
    - Thumbnails have no explicit rule (not verified).
  - **Scraping:** prohibited (III.E.6).
  - **Export:** there is no explicit export clause. Section III.E grants no rights beyond those it lists.

### Pagination
- **search.list:**
  - maxResults ranges from 0 to 50.
  - "Search results are constrained to a maximum of 500 videos" in the channelId + type=video case.
  - totalResults is approximate.
- **channels.list:** `forHandle` accepts an optional leading `@`. maxResults ranges from 0 to 50.

## Bluesky / AT Protocol

### Hosts
- **`public.api.bsky.app`:** the public, cached AppView. "Use this for unauthenticated `app.bsky.*` reads — no token required." Sources: https://bsky.network/docs/api-directory and https://endpoints.bsky.app/openapi.bluesky-app.json
- **`api.bsky.app`:** listed only as the AppView service DID `did:web:api.bsky.app#bsky_appview`.
- **searchPosts:** "may require authentication (eg, not public) for some service providers and implementations."
  - The spec declares no Bearer requirement.
  - Nothing in the documentation explains why we saw 403 on public.api.bsky.app and 200 on api.bsky.app.

### Rate limits
Source: https://bsky.network/docs/rate-limits

- **PDS:** 3,000 requests per 5 minutes per IP.
- **createSession:** 30 per 5 minutes and 300 per day, per account.
- **AppView:** no numbers are published. The docs say the "generous rate-limits" and invite you to contact them if you hit a limit.

### Policies
- **Developer Guidelines** (https://bsky.network/docs/developer-guidelines):
  - "All services must have a method for deleting content a user has requested to be deleted."
  - Do not spam or generate automated or bulk interactions.
  - Provide report and block tools.
  - Name the app "[App Name] for Bluesky".
  - They do not address storing posts, commercial use, AI/ML or scraping.
- **Protocol account spec** (https://atproto.com/specs/account):
  - Content from deleted accounts "should be removed from the network".
  - Content from deactivated accounts "should not be displayed or redistributed".
  - Public access to deleted records should be removed.
- **Terms of Service** (https://bsky.social/about/support/tos, updated 2025-08-14): third-party apps are governed by their own terms.
- **Privacy policy:** "Your posts and comments are public."

### Data fields
- **Post metrics:** likeCount, repostCount, replyCount, quoteCount, bookmarkCount. **There is no view or impression count.**
- **Profile metrics:** followersCount, followsCount, postsCount.
- **getAuthorFeed:** limit 1–100, opaque cursor. Supports the filters posts_no_replies, posts_with_media, posts_with_video and others.
- **searchPosts:**
  - limit 1–100.
  - The cursor "may not necessarily allow scrolling through entire result set".
  - hitsTotal is optional and approximate.
