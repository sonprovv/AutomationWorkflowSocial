# ADR-0006: TikTok BLOCKED, Meta platforms AUTH_REQUIRED, no scraping adapters by default

- **Status:** Accepted. Revisit after the Product Owner decides; see docs/feasibility/README.md §5.
- **Date:** 2026-11-26
- **Phase:** 0

## Context
**TikTok:**
- The Display API only returns data about the user who authorizes it.
- The Research API excludes commercial use.
- The Commercial Content API covers ads only, and only in the EU.
- TikTok's Terms of Service §3.4 forbid automated extraction without written approval.
- Apify's scraper works and costs from $1.70 per 1,000 results. Apify's terms put the legal responsibility on the customer.

**Meta:** each of these features requires App Review, Business Verification, or both:
- Facebook PPCA.
- Instagram Business Discovery and Hashtag Search.
- Threads keyword search and profile discovery.

## Decision
- **We do not build or enable any scraping-based adapter by default.** A LEGAL_RISK provider can only be added after the Product Owner and legal accept it in writing, recorded in a new ADR. Even then it must be:
  - isolated from other adapters,
  - opt-in,
  - capped by budget,
  - labelled in the UI and in exports.
- Capability records:
  - TikTok is `BLOCKED`.
  - Facebook, Instagram and Threads are `AUTH_REQUIRED`, and each record lists the exact credentials it needs.
- The MVP continues with Bluesky and YouTube, as Master Plan §1.2 and §4.3 instruct.

## Consequences
- TikTok is the next business priority (Master Plan §1.2), but it is not available in the MVP.
- The recommended interim option is manual URL import with oEmbed metadata only. Its terms must be checked before building it.
