# ADR-0018: App Spy — Apple App Store via the official Search API, social links only with evidence

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 9 (P9-03)

## Context
App Spy should show competitors' apps (search, details, developer, website) and connect each app to the company's social accounts. Sources must be official, and an app must never be matched to an account by name.

## Decision
1. **Source: Apple iTunes Search/Lookup API.** It is official, public and needs no credential. Two live PoC runs passed with identical results ([docs/feasibility/apple-app-store.md](../feasibility/apple-app-store.md)).
   - **Google Play is BLOCKED.** Google has no public catalogue API, and scraping is excluded ([google-play-apps.md](../feasibility/google-play-apps.md)). Google Play links get `422 NOT_SUPPORTED`.
2. **Separate package and records.** The code is `@sss/collector-appstore`, with records in `docs/feasibility/app-stores/*.json` (`storeRecordSchema`). App stores are not social providers, so they stay outside the social capability matrix and the provider registry.
3. **Limits.**
   - The client paces itself to one call every 3.1 s per process; Apple documents about 20 calls per minute.
   - `APPLE_SEARCH_DAILY_REQUESTS` (default 2000) caps a UTC day. It is checked before each operation, and every call is written to `usage_logs` as `apple-itunes-search`.
4. **Policy (deny-by-default, `apple-itunes-search-v0`).**
   - App Spy keeps the **latest** listing of apps the user tracks, overwritten on refresh: no history and no export.
   - No icons or screenshots: Apple allows promo content only to promote the store. Every app shows its App Store link.
   - The proposal (daily snapshots for 365 days, export for internal research) waits for the Product Owner.
5. **Social links need evidence.**
   - **Chain:** store listing → developer website the store lists (`sellerUrl`) → a profile link published on that page.
   - The page is fetched once, on request, through `fetchPublicPage`:
     - http(s) on ports 80/443 only, no credentials in the URL;
     - every resolved address must be public, and the socket connects to the checked address, which blocks DNS rebinding;
     - up to 3 redirects, each re-checked; HTML only; 1 MB and 10 s.
   - Only anchors that are profile URLs count: share buttons, posts, hashtags and intents are ignored.
   - **Confidence:** HIGH when the page stayed on the listed site; MEDIUM when it redirected to another site.
   - **Matching a tracked account** needs the same platform plus the same handle, id or profile URL. Names are never used.
   - **Status:** links start PROPOSED. The user confirms or rejects them, and running discovery again keeps those decisions.
6. **API and UI.**
   - API: `/apps/policy`, `/apps/search` (live, nothing stored), `/apps` (track and list), `/apps/:id` (refresh, developer-apps, discover-links, delete) and `/app-links/:id`.
   - UI: the **App Spy** page and the app detail page.

## Consequences
- **Coverage:** about 25–29% of listings have no developer website, so they cannot be linked. The UI says so; it does not guess.
- **Search is fuzzy.** Results are labelled as suggestions, and tracking uses ids.
- **Not available:** downloads, revenue, rankings and ad spend. The UI says they are not available and never estimates them.
- **Tests:** unit tests use a fake Apple server; the SSRF tests cover private DNS answers and DNS rebinding; integration tests run the API. A real-data check (Goodnotes: 5 profiles, all HIGH) was done in the local app.

## Alternatives considered
- **Scraping App Store or Play web pages:** rejected (project rules).
- **Matching apps to accounts by developer name:** rejected, because names are ambiguous and easy to fake.
- **Paid app-intelligence vendors:** an open Product Owner decision. Each would need its own record.
