# Feasibility: Reddit — UNVERIFIED

Checked 2026-11-26. Desk research only: no credentials, no API calls. Outside MVP scope (Master Plan §1.2).
- The official pages returned HTTP 403 to our automated fetcher:
  - https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
  - https://redditinc.com/policies/data-api-terms
- Secondary sources report:
  - The free tier allows 100 QPM per OAuth client.
  - Unauthenticated traffic is blocked.
  - Commercial use requires a separate agreement.
- None of this is verified.
- **Action:** a person needs to read the terms above in a browser. Credentials needed: a Reddit OAuth client, and probably a commercial agreement.
- Record: [`capabilities/reddit.json`](capabilities/reddit.json)
