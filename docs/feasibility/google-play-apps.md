# App Spy feasibility: Google Play

- **Status:** BLOCKED. Record: `docs/feasibility/app-stores/google-play.json`.
- **Checked:** 2026-11-27.

## Findings
- **No official public catalogue API.** Google publishes no API to search Google Play or read another developer's listing.
- **The Google Play Developer API (androidpublisher)** covers publishing and management tasks "similar to those available to a developer through the Play Console": releases, store listings, products, purchases.
- **Its Reply to Reviews API** reads "user feedback for your app", by package name, and only for apps in the caller's own Play Console:
  - only reviews with text, created or modified in the last week;
  - 200 GET calls per hour per app.
- **Scraping `play.google.com`** (directly or through unofficial libraries) is out of scope under the project rules.

## What App Spy does
- A Google Play link is refused with `NOT_SUPPORTED` and a pointer to this page. Nothing is fetched.

## Options for the Product Owner
1. Keep App Spy iOS-only (current state).
2. Buy a licensed app-intelligence data feed (for example data.ai or Sensor Tower). This is paid and needs a contract and terms review; it would get its own feasibility record.
3. For your own Android apps only: connect the Play Developer API with a service account (AUTH_REQUIRED). This does not give competitor data.
