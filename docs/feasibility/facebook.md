# Feasibility: Facebook Pages (Meta Graph API)

**Status: AUTH_REQUIRED.** Collection is possible in principle through **Page Public Content Access (PPCA)**. That access requires Meta App Review and Business Verification, which we do not have.

| Field | Value |
|---|---|
| Checked | 2026-11-26 (desk research only; no app or token, so no API calls) |
| Capability record | [`capabilities/facebook.json`](capabilities/facebook.json) |

## Findings
- **PPCA**
  - Gives access to the Pages Search API, plus `/{page}/feed`, posts and comments of Pages the app does not manage.
  - The allowed use case is "Analyze and/or display posts and engagement on Pages".
  - Needs App Review and Business Verification. Without it, a live app "cannot see any Page public content".
  - Source: https://developers.facebook.com/docs/features-reference/page-public-content-access
- **Page Public Metadata Access**
  - Gives like and follower counts and "about" information only.
  - It is mutually exclusive with PPCA.
  - Source: https://developers.facebook.com/docs/features-reference/page-public-metadata-access
- **Rate limit:** Business Use Case limit of 4800 × engaged users per 24 hours. Meta advises a system user token for PPCA.
- **Meta Platform Terms (https://developers.facebook.com/terms/):**
  - §3.d.i: delete data when it is no longer needed or when asked.
  - §3.a: no surveillance tools, and no selling of Platform Data.
- **Out of scope:** personal profiles and groups. **Post keyword search: not available** (only Pages search).

## What the user must provide to unlock this source
1. A Meta Business account with **Business Verification** completed.
2. A Meta app (`META_APP_ID`, `META_APP_SECRET`) submitted to **App Review for PPCA**, with a screencast of the use case.
3. A **system user access token**.

Approval takes weeks and is not guaranteed.

## Alternative until access is approved
- Manual import of Page URLs, storing only the URL and display name.
- The public **Meta Ad Library** for the Ad Spy module (Master Plan §18). Ad Spy is a separate feasibility item for later.

## Gate decision
⏳ **AUTH_REQUIRED.** Not part of the MVP verification set. When credentials arrive we re-run Phase 0 with the same harness, after adding a Facebook adapter.
