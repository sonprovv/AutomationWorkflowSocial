# Feasibility: Pinterest — AUTH_REQUIRED / LIMITED

Checked 2026-11-26. Desk research only: no credentials, no API calls. Outside MVP scope (Master Plan §1.2).
- **Access tiers:** Trial allows 1,000 requests per day. Standard requires a demo video of the OAuth flow. Source: https://developers.pinterest.com/docs/key-concepts/access-tiers/
- Apps registered after 2026-09-14 may get `PINNER_DATA_ACCESS_DENIED` when reading non-business users' data.
- **Partner keyword search** (`/search/partner/pins`) is beta-gated. We could not verify it on the official site.
- Reading other accounts' pins and metrics is NOT VERIFIED.
- Record: [`capabilities/pinterest.json`](capabilities/pinterest.json)
