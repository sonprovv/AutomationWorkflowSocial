# Feasibility: YouTube Data API v3

**Status: AUTH_REQUIRED.** The adapter is built and contract-tested. Live verification is waiting for a `YOUTUBE_API_KEY`.

| Field | Value |
|---|---|
| Checked | 2026-11-26 |
| Provider | `youtube-data-api-v3` (`packages/collectors/youtube`) |
| Capability record | [`capabilities/youtube.json`](capabilities/youtube.json) |
| Run evidence | [`runs/youtube/`](runs/youtube/): run 1 was credential checks only (no key) |
| Credentials | `YOUTUBE_API_KEY` (API key only, no OAuth: we only read public data) |
| Cost | $0 in money. Quota-limited (see §4) |

## 1. What was verified without a key (live)

| Check | Result |
|---|---|
| The API accepts the key in the `X-Goog-Api-Key` **header** | ✅ Verified. An invalid key in the header returned `API_KEY_INVALID`, which proves the header is read. The key therefore never appears in URLs or request logs. |
| Invalid key is classified correctly | ✅ HTTP 400, `details[].reason=API_KEY_INVALID`. The adapter maps this to `AUTH_REQUIRED`, and `validateCredentials()` reports `INVALID`. |
| Missing key is classified correctly | ✅ HTTP 403, `ACCESS_DENIED`. The adapter short-circuits with `MISSING` and makes no request. |

Both error bodies are kept as captured fixtures in `tests/fixtures/youtube/`.

## 2. Implementation (contract-tested against a local fake API)

| Capability | API calls | Quota (units) |
|---|---|---|
| resolveAccount | `channels.list`. Lookup depends on the input: `id=` for `/channel/UC…`, `forHandle=` for `@handle`, `forUsername=` for `/user/`, and `videos.list` → channelId for a video URL | 1 (2 for a video URL) |
| getProfile | `channels.list part=snippet,statistics,contentDetails` | 1 |
| searchAccounts | `search.list type=channel`, then a batched `channels.list` for real statistics | search + 1 |
| searchPosts | `search.list type=video` (`regionCode`, `relevanceLanguage`, `publishedAfter/Before`), then a batched `videos.list` | search + 1 |
| listPosts | uploads playlist → `playlistItems.list` → batched `videos.list` | 2 per page of up to 50 |
| getPostDetail / getPostMetrics | `videos.list`, batched 50 per call | 1 per 50 videos |
| listComments | `commentThreads.list` (top-level comments) | 1 |

**Stable IDs:**
- Channel ID: `UC…`, 24 characters. Handles can change; channel IDs do not.
- Video ID: 11 characters.

**How missing values are recorded (never as 0):**
- Hidden subscriber count: `followers=null`, reason `HIDDEN_BY_OWNER`.
- No `likeCount`: `likes=null`, reason `HIDDEN_BY_OWNER`.
- No `commentCount`: `comments=null`, reason `DISABLED`.
- Shares and saves: always null, reason `NOT_SUPPORTED`.

**Typed errors:**

| YouTube reason | Normalized code |
|---|---|
| `quotaExceeded` / `dailyLimitExceeded` | `QUOTA_EXCEEDED` (not retried; quota resets at midnight Pacific Time) |
| `rateLimitExceeded` | `RATE_LIMITED` (retried with backoff) |
| `accessNotConfigured` | `PERMISSION_DENIED` ("API not enabled") |
| Key restriction reasons | `PERMISSION_DENIED` |
| `commentsDisabled` | `PERMISSION_DENIED` |
| `*NotFound` | `NOT_FOUND` |
| `keyExpired` | `AUTH_EXPIRED` |

## 3. Policy: the most important constraint

Source: https://developers.google.com/youtube/terms/developer-policies, checked 2026-11-26. Short quotes are in `_research/youtube-bluesky-docs-review-2026-11-26.md`.

| Rule | Consequence for the product |
|---|---|
| Data from channels we do not own is **Non-Authorized Data** (§IV). Store "limited amounts" temporarily, for **at most 30 days**, then delete or refresh (III.E.4.d). Statistics are limited to 30 days (III.E.4.b). | `retentionDays=30` and `refreshDays=30`. Phase 4 cleanup (WF14) must enforce this, and run files and samples carry a `deleteBy` date. |
| **No derived or new metrics** (III.E.4.h). The exception is **III.L derived-metrics policy** (from 2026-06-01), which only covers *audited* developers with analytics use cases. It allows averages and growth rates, storing statistics for up to 36 months, and cross-channel comparison. | The viral score, velocity and engagement rate (WF07) are **disabled for YouTube**, as the Master Plan already says. They can only be enabled after a compliance audit and III.L approval. |
| Do not aggregate data across different content owners (III.E.2.a). | Cross-competitor YouTube benchmarks stay off until III.L applies. |
| Do not download or cache audiovisual content (III.E.1.a), and do not separate audio from video (III.I.7). | No media processing for YouTube. AI analysis (WF08) is limited to metadata: title, description and thumbnail URL. |
| Attribute YouTube as the source (III.F.2). | The UI and exports must show YouTube attribution and the link to the original. |
| Delete within 7 days of a request (III.E.4.g). | Phase 4 needs a delete-by-request path. |

**Effective policy (`youtube-nonauthorized-v0`):** deny on history, derived metrics, media and export. Retention is 30 days.

## 4. Quota and cost

**Quota limits:**
- The default allocation is 10,000 units per day for read endpoints. Reset is at midnight Pacific Time.
- **The docs reviewed on 2026-11-26 describe a separate search bucket: 100 `search.list` calls per day, 1 unit each.** Historically a search cost 100 units. Until we confirm the new model with a live key, the harness **reserves 100 units per search** as an upper bound (`DEFAULT_QUOTA_COSTS.search`). Either way, search allows about 100 calls per day.
- A run budget is enforced through `YOUTUBE_POC_MAX_UNITS` (default 1500). The budget is checked *before* each call; this is tested.

**Pilot estimate (50 channels, 20 videos each):**

| Job | Units per day |
|---|---|
| Profile sync, once a day (50 IDs in 1 batched call) | 1 |
| New-post detection every 2 h (50 × [playlistItems + videos]) | 1,200 |
| Metrics refresh for 1,000 videos every hour (20 batched calls) | 480 |
| Discovery: 20 keyword searches + 20 batched enrichments | 20 searches + 20 |

**Total: about 1,700 units per day plus 20 searches.** This fits the default quota. Search is the scarce resource, at 100 calls per day.

## 5. What the user needs to do

1. Open Google Cloud Console and create or select a project.
2. Enable **YouTube Data API v3**.
3. Create an **API key** and restrict it to YouTube Data API v3.
4. Put the key in the local `.env` file as `YOUTUBE_API_KEY=…`. Do not send it through chat.
5. Run `npm run poc -- youtube` three times at different times, then `npm run poc:summary`.

## 6. Gate decision

⏳ **Pending.** The status becomes VERIFIED once at least 3 live runs pass with a real key. Until then, Phase 0 has one verified source (Bluesky), and the gate requires 2 (Master Plan §16).
