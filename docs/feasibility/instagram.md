# Feasibility: Instagram (Instagram Graph API)

**Status: AUTH_REQUIRED.** Limited competitor data is available through **Business Discovery** and **Hashtag Search**. Both need the user's own Business/Creator account and Meta app approval.

| Field | Value |
|---|---|
| Checked | 2026-11-26 (desk research only, no API calls) |
| Capability record | [`capabilities/instagram.json`](capabilities/instagram.json) |

## Findings
- **Business Discovery**
  - Call: `GET /<OWN_IG_USER_ID>?fields=business_discovery.username(<target>){followers_count,media_count,media{like_count,comments_count,…}}`.
  - Only works when the target is a **Business or Creator** account and you already know its username.
  - Needs the `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement` permissions with Advanced Access.
  - Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- **Hashtag Search**
  - Needs Instagram Public Content Access.
  - Limited to **30 unique hashtags per rolling 7 days**.
  - `recent_media` only covers the **last 24 hours**.
  - Usernames are not returned.
  - Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
- **Not available:** keyword search of accounts or posts, data about personal accounts, and comments on other accounts' posts.
- **Hidden like counts** are left out of the response. We store them as `null`, never 0.

## Capability mapping
| Capability | Status |
|---|---|
| resolveAccount, getProfile, listPosts, getPostMetrics | AUTH_REQUIRED (via Business Discovery) |
| searchPosts | PARTIAL (hashtags only, 30 per week) |
| searchAccounts, listComments | NOT_SUPPORTED |

## What the user must provide
1. Their own Instagram Business or Creator account, linked to a Facebook Page.
2. A Meta app with Advanced Access to the permissions above.
3. Instagram Public Content Access, if hashtag search is needed.
4. A long-lived user token.

## Gate decision
⏳ **AUTH_REQUIRED.** Not part of the MVP verification set.
