# Feasibility: LinkedIn — BLOCKED for competitor posts

Checked 2026-11-26. Desk research only: no credentials, no API calls. Outside MVP scope (Master Plan §1.2).
- `r_organization_social` only works for organizations where the authenticated member has an admin or poster role. **Competitors' posts and metrics cannot be read.** Source: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- For other organizations we can only get basic fields (name, vanity name, logo, website) and the follower count through `networkSizes`.
- There is no keyword search for posts.
- The Community Management API needs an application. The Company Intelligence API is not accepting applications.
- **What is possible:** profile-level follower tracking through organization lookup, if the app is approved.
- Record: [`capabilities/linkedin.json`](capabilities/linkedin.json)
