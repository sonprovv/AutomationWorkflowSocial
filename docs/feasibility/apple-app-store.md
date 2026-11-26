# App Spy feasibility: Apple App Store (iTunes Search / Lookup API)

- **Status:** VERIFIED (technical). The data policy is **pending a Product Owner decision**: `docs/feasibility/app-stores/apple.json`, policyProposal.
- **Checked:** 2026-11-27. PoC: `npm run poc:apps`, 2 runs 8 minutes apart with identical results (8 PASS / 2 PARTIAL / 0 FAIL). Run logs are in `runs/apple-app-store/`.
- **Source:** official, public, no credential: `https://itunes.apple.com/search` and `/lookup`.

## Results of the PoC (real calls)

| Check | Result | What was found |
|---|---|---|
| A1 Search by keyword (us) | PASS | 24 apps for "note taking". Every app has bundle id, developer id, rating, rating count and last update; 75% list a developer website (`sellerUrl`) |
| A2 Unicode keyword, Vietnam storefront | PASS | "ngân hàng" (vn) returned 24 apps |
| A3 Nonsense keyword | PARTIAL | 3 loosely related apps instead of none: **search is fuzzy**, so results are suggestions, never proof of a match |
| A4 Lookup by id | PASS | Same app; about 40 fields |
| A5 Several ids in one call | PASS | Ids not sold in the storefront are simply absent |
| A6 Lookup by bundle id | PARTIAL | Works, but is not in Apple's documentation |
| A7 Developer and their apps | PASS | `lookup?id=<developer id>&entity=software` returns the developer, then their apps |
| A8 Unknown id | PASS | Empty result, not an error |
| A9 Same app in another storefront | PASS | Available in vn; rating differs (4.718 us vs 4.715 vn), so ratings are per storefront |
| A10 Developer website → social links | PASS | 3 websites fetched. 2 publish profile links (for example Goodnotes: x, facebook, instagram, tiktok, linkedin). One redirects to another site (gingerlabs.com → notability.com). One has no links |

Requests: 9/9 HTTP 200 per run, p50 about 300 ms, max 1.3 s, paced every 3.1 s. No 403 or 429.

The app as built was also checked with real data: Goodnotes was tracked from its App Store link, and its website gave 5 proposed profiles (facebook, instagram, linkedin, tiktok, x), all HIGH.

## Rules and limits (sources in the record)
- **Rate limit:** "approximately 20 calls per minute (subject to change)". Apple suggests caching, and the Enterprise Partner Feed for heavier use.
- **Promo content:** previews, artwork and app icons may be used "only to promote store content and not for entertainment purposes". App Spy stores and shows **no icons or screenshots** and always links to the App Store page.
- **Listing metadata:** Apple's pages do not say whether it may be stored. Until the Product Owner decides, App Spy keeps only the **latest** listing of apps the user tracks: no history and no export.

## What App Spy does with it
- **Search and track:** search (suggestions only); track an app by App Store link, id or bundle id; refresh it; list the developer's other apps.
- **Social accounts from the developer website**, as a chain of evidence:
  - the store listing gives the developer website (`sellerUrl`);
  - App Spy fetches that page once, on request, behind the SSRF guard;
  - profile links published on the page become **proposed** links, each with its evidence (website, final URL after redirects, the exact href, fetch time).
  - A proposed link matches a tracked social account only when platform and handle are equal. **Names are never matched.** A website that redirects to another site gets confidence MEDIUM instead of HIGH. The user confirms or rejects each link.

## Not possible from this source
- Download counts, revenue, keyword ranking, chart positions or ad spend. App Spy shows none of these and never estimates them.
- Reviews: not part of this API.
- Apps without a listed developer website (about 25–29% in the sample) cannot be linked to social accounts.
