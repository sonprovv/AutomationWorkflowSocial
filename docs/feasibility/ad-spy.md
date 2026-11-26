# Ad Spy feasibility (desk research, P9-04)

- **Checked:** 2026-11-27, from official documentation only. No PoC was run and no adapter was built.
- **Records:** [`ad-sources/*.json`](ad-sources/), schema-tested by `tools/feasibility/test/ad-sources.test.ts`.
- **Rule for every source:** App Spy and Ad Spy never infer **spend, revenue or ROAS**. A spend figure can appear only when the source itself publishes it, and then only in the published form. Today that means Meta's ranges for political and issue ads.

## Summary

| Source | Status | Who can use it | Coverage | Spend | Decision for the Product Owner |
|---|---|---|---|---|---|
| **Meta Ad Library API** (`ads_archive`) | AUTH_REQUIRED | Meta developer app, user token, identity and location confirmation (steps unverified: page 403) | All ads delivered to the **EU**; political and issue ads worldwide. Commercial ads that never reached the EU are not returned | Ranges, **political and issue ads only** | PoC only if competitors advertise in the EU. Needs the account owner's identity confirmation |
| **Google Ads Transparency Center** | BLOCKED | No official API found | Website: global, browse-only. A BigQuery dataset is reported for EEA/Turkey advertisers (community sources, unverified) | None | Create a Google Cloud project if a BigQuery PoC is wanted; scraping stays excluded |
| **TikTok Commercial Content API** | LEGAL_RISK | Application, for "the public and researchers"; approval in about 2 working days | **EU/EEA ads only**, up to one year after last shown | None (reach buckets only) | Terms limit data to research into advertising risks. Competitor monitoring needs legal advice first |

## Details

### Meta Ad Library API
- **Endpoint:** `GET /v27.0/ads_archive`.
  - Filters: `ad_reached_countries`, `ad_type` (ALL or special categories), `search_terms` (up to 100 characters), `search_page_ids` (up to 10 Pages).
- **Rule:** "Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics."
- **Fields:**
  - ad text and link titles, delivery start and stop, page id and name, platforms, languages, `ad_snapshot_url`;
  - EU ads also have `eu_total_reach`, target ages, gender and locations, and beneficiary/payer;
  - political and issue ads also have `spend` and `impressions` **as ranges**, plus demographic and regional distribution as percentages.
- **Retention in the library:** EU ads for one year after the last impression; political ads for 7 years.
- **Not verified:**
  - the onboarding page (identity confirmation, token): it returned HTTP 403 to our fetcher;
  - rate-limit numbers: only error 613 is documented;
  - any separate API terms.

### Google Ads Transparency Center
- **No API.** The site is a JavaScript application, and its FAQ could not be read. The help article URL returned 404.
- **Reported BigQuery dataset:** `bigquery-public-data.google_ads_transparency_center` (`creative_stats`, `removed_creative_stats`), covering advertisers that served ads in the EEA or Turkey. Community threads report it; the official dataset page failed to load, so fields, coverage and terms are unverified.
- **BigQuery public datasets in general (official):** Google pays for storage, and the first 1 TB of queries each month is free.
- Third-party scraper actors exist; they are excluded under the project rules.

### TikTok Commercial Content API
- **Endpoints:**
  - `POST /v2/research/adlib/ad/query/`: filters by term (up to 50 characters), country list, date range, type, status, reach bucket, age and gender; at most 10 results per page;
  - `POST /v2/research/adlib/advertiser/query/`: returns business name, id and country.
- **Fields:** id, first and last shown dates, status, video URLs, image URLs, reach bucket (for example "11K"). There is no spend field.
- **Terms:** CCL data is for "supervision and research into emerging risks" from online advertising (Developer Terms II.5), and all data must be deleted when access ends.

## What would need to happen next
1. **Product Owner:** decide whether EU-only or political-only coverage is useful for the competitors you track.
2. **If Meta:** the account owner creates a Meta developer app and completes identity confirmation, then adds the token to `.env`. A PoC like Phase 0 follows: three runs, with a capability record moved to VERIFIED only on evidence.
3. **If Google BigQuery:** create a Google Cloud project, then run a PoC that queries `creative_stats` for one known advertiser.
4. **TikTok:** only after legal advice on the CCL purpose limit.
