# Feasibility: TikTok

**Status: BLOCKED.** No official API grants commercial access to other accounts' organic content. The only working alternative is third-party scraping, which is classed as **LEGAL_RISK** and is not enabled.

| Field | Value |
|---|---|
| Checked | 2026-11-26 (desk research on official documentation, no API calls) |
| Capability record | [`capabilities/tiktok.json`](capabilities/tiktok.json) |
| Sources | [`_research/official-docs-review-2026-11-26.md`](_research/official-docs-review-2026-11-26.md) |

## 1. Official APIs

| API | Can it read other accounts' content? | Commercial use allowed? | Source |
|---|---|---|---|
| Display API | No. Only the **authorizing** user's own profile and videos, via a user OAuth token. | Yes, but only for that user's own data | https://developers.tiktok.com/doc/display-api-overview |
| Research API | Yes: keyword, username and hashtag queries with view, like, comment and share counts | **No.** Academic institutions and EU non-profits only. Applicants must be "independent of commercial interests", the FAQ says "No" to commercial users, and the terms forbid "any commercial … purpose". | https://developers.tiktok.com/products/research-api/, https://developers.tiktok.com/doc/research-api-faq |
| Commercial Content API | Ads and commercial content only, EU only | Whether commercial companies may use it is not verified | https://developers.tiktok.com/products/commercial-content-api/ |

## 2. Third-party provider (Apify)

- **Actor:** `clockworks/tiktok-scraper`. Pay-per-event pricing, from **$1.70 per 1,000 results** (checked 2026-11-26).
- **Fields returned:** playCount, diggCount, shareCount, commentCount, collectCount, author fans, and more.
- **Apify General Terms §5.8 and §11.1:** the customer alone is responsible for the legality of the data and indemnifies Apify for data taken from unauthorized sources.
- **TikTok Terms of Service §3.4:** you may not "scrape, crawl, export or otherwise extract any data … using any automated system … except as approved in writing by TikTok".

Buying data from a provider does not grant the right to collect it (Master Plan §4.1). That leaves scraping in direct conflict with TikTok's terms. **Verdict: LEGAL_RISK. Not implemented and not enabled.**

## 3. Alternatives (decision needed from the Product Owner)

1. **Recommended: manual URL import with metadata only.** The user pastes TikTok video or profile URLs. The system calls TikTok's public **oEmbed** endpoint (`https://www.tiktok.com/oembed?url=…`, a documented embed API) to get the title, author and thumbnail for display and AI caption analysis. It returns no metrics, so we never invent any. ⚠ We have not yet checked whether oEmbed's terms permit this use. That check is the next verification step if this option is chosen.
2. **Display API for accounts we own or that grant OAuth.** This works for the user's own brand accounts, or for partner creators who consent. It does not cover competitors.
3. **Apify or another scraper**, only with a written decision from the Product Owner and legal sign-off accepting the risk. The adapter would be isolated, opt-in, budget-capped and labeled `LEGAL_RISK` in the UI and in exports.
4. **Watch for changes.** Re-check commercial access to the Research and Commercial Content APIs each quarter.

## 4. Gate decision

❌ **BLOCKED for the MVP.** We continue with other adapters, as the Master Plan instructs ("Không có nguồn phù hợp thì đánh dấu BLOCKED và tiếp tục").
