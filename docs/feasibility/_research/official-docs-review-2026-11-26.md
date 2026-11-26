# Official documentation review — TikTok, Meta (FB/IG/Threads), Reddit, X, Pinterest, LinkedIn

- **Review date:** 2026-11-26
- **Method:** desk research on official developer documentation, done by an AI research agent. Every fact cites its source URL.
- **Not covered:** no credentialed API calls were made for these platforms. The reason is in each `docs/feasibility/<platform>.md`.
- **Inaccessible sources:** reddit.com, redditinc.com and support.reddithelp.com returned HTTP 403 to the fetcher. Reddit facts are therefore **NOT VERIFIED** and must be re-checked by a person in a browser.

## TikTok

### Display API
- It returns the *authorizing* user's profile (`/v2/user/info/`) and that user's own public videos (`/v2/video/list/`).
- The token must "bear the authorization of the TikTok user". Scopes: `user.info.basic`, `video.list`.
- No endpoint was found for reading an arbitrary third-party account, and there is no keyword search.
- Sources: https://developers.tiktok.com/doc/display-api-overview, https://developers.tiktok.com/doc/tiktok-api-v2-video-list

### Research API
- Supports keyword, username and hashtag queries. Returns view, like, comment, share and favorites counts. Each request covers a window of at most 30 days.
- Source: https://developers.tiktok.com/doc/research-api-specs-query-videos
- **Eligibility:**
  - Academic institutions (US, EEA, UK, CH, CA) and EU not-for-profit research bodies.
  - Applicants must "Be independent of commercial interests".
  - The FAQ answers "No" to creators, advertisers and commercial users.
  - Sources: https://developers.tiktok.com/products/research-api/, https://developers.tiktok.com/doc/research-api-faq
- **Terms:** use "for any commercial or unauthorized purpose" is prohibited (§III). Data must be refreshed at least every 30 days and deleted on termination. Source: https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en
- **Quota:** 1,000 requests and 100,000 records per day.

### Commercial Content API
- Covers ads and commercial content only, EU data only. It does not cover organic posts.
- Source: https://developers.tiktok.com/products/commercial-content-api/

### Third-party scraper (Apify `clockworks/tiktok-scraper`)
- **Price:** pay-per-event, "from $1.70 / 1,000 results".
- **Fields:** playCount, diggCount, shareCount, commentCount, collectCount, authorMeta.fans and others.
- Source: https://apify.com/clockworks/tiktok-scraper
- **Apify General Terms:**
  - §5.8: the customer is "solely responsible for the legality … of all Customer Data".
  - §11.1: the customer indemnifies Apify for data extracted "from unauthorized sources".
  - Source: https://docs.apify.com/legal/general-terms-and-conditions
- **TikTok Terms of Service §3.4 (US):** you may not "scrape, crawl, export or otherwise extract any data or content in any form, for any purpose, from the Platform using any automated system or software … except as approved in writing by TikTok". Source: https://www.tiktok.com/legal/page/us/terms-of-service/en

## Facebook Pages
- **Page Public Content Access (PPCA):**
  - Gives access to the Pages Search API and to `/page/feed`, posts and comments of Pages you do not manage. The stated use case is "Analyze and/or display posts and engagement on Pages."
  - Requires App Review and Business Verification.
  - Source: https://developers.facebook.com/docs/features-reference/page-public-content-access
- **Page Public Metadata Access:**
  - Covers like and follower counts and "about" information only.
  - Cannot be held together with PPCA.
  - Source: https://developers.facebook.com/docs/features-reference/page-public-metadata-access
- **Rate limits:** the BUC formula is 4800 × engaged users per 24 hours. Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- **Meta Platform Terms (https://developers.facebook.com/terms/):**
  - §3.d.i: delete data when it is no longer needed for a legitimate business purpose, or when Meta or the user requests it.
  - §3.a: no surveillance tools, and no selling or licensing of Platform Data.

## Instagram
- **Business Discovery:**
  - Call shape: `GET /<OWN_IG_USER_ID>?fields=business_discovery.username(<target>){followers_count,media_count,media{like_count,comments_count,…}}`.
  - Works only for Business and Creator target accounts, and you must already know the username.
  - Needs `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement`.
  - Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- **Hashtag Search:**
  - Requires Instagram Public Content Access.
  - Limited to 30 unique hashtags per rolling 7 days.
  - `recent_media` returns only the last 24 hours, and the `username` field is not returned.
  - Sources: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search, https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media
- **Free-text keyword search:** not available for posts or accounts.

## Threads
- **`GET /keyword_search`:**
  - Supports TOP or RECENT ordering, KEYWORD or TAG mode, `since`/`until`, and `limit` up to 100.
  - Without approval of `threads_keyword_search`, it returns only the authenticated user's own posts.
  - Limited to 2,200 queries per 24 hours.
  - Source: https://developers.facebook.com/docs/threads/keyword-search
- **`GET /profile_lookup?username=`:**
  - Needs `threads_profile_discovery`.
  - Works only on public profiles with at least 100 followers. Standard access can look up only Meta's own accounts.
  - Limited to 1,000 requests per 24 hours.
  - Source: https://developers.facebook.com/docs/threads/threads-profiles
- **Insights:** available only for the user's own posts. Source: https://developers.facebook.com/docs/threads/insights

## Reddit — NOT VERIFIED (official pages blocked the fetcher)
- Secondary sources report:
  - A free tier of 100 queries per minute per OAuth client.
  - Unauthenticated traffic is blocked.
  - Commercial use requires a separate agreement.
- A person must verify this at https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki and https://redditinc.com/policies/data-api-terms

## X
- **Pricing:**
  - Pay-per-usage with prepaid credits.
  - Post read $0.005 per resource, user read $0.010.
  - Capped at 3M post reads per billing cycle.
  - Source: https://docs.x.com/x-api/getting-started/pricing
- **Recent search:** covers the last 7 days and is available to all developers, 100 results per request. Full-archive search requires pay-per-use or Enterprise. Source: https://docs.x.com/x-api/posts/search/introduction
- **Rate limits:** https://docs.x.com/x-api/fundamentals/rate-limits
- **Storage:** stored content must be kept up to date, and deleted or protected content must be removed, within 24 hours when requested. Source: https://docs.x.com/developer-terms/policy

## Pinterest
- **Access tiers:** Trial (1,000 requests per day), then Standard (requires a demo video).
- Apps registered after 2026-09-14 may receive `PINNER_DATA_ACCESS_DENIED` for data about non-business users.
- Sources: https://developers.pinterest.com/docs/key-concepts/access-tiers/, https://developers.pinterest.com/docs/reference/rate-limits/
- **Partner keyword search (`/search/partner/pins`):** beta-gated, NOT VERIFIED on the official site.

## LinkedIn
- **Organizations you do not administer:** only basic organization lookup fields are available, plus the follower count through `networkSizes`.
- **Posts:** `r_organization_social` is restricted to organizations where the authenticated member holds an admin or poster role. Competitors' posts are therefore not readable.
- **Search:** no post keyword search is documented.
- **Access:** Community Management API tiers require an application. Company Intelligence API is not accepting applications.
- Sources: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api, https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api, https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
