# Feasibility: X — AUTH_REQUIRED (paid, technically feasible)

Checked 2026-11-26. Desk research only: no credentials, no API calls. Outside MVP scope (Master Plan §1.2).
- **Pricing:** pay-per-use with prepaid credits. Source: https://docs.x.com/x-api/getting-started/pricing
  - Post read: $0.005 per resource.
  - User read: $0.010 per resource.
  - Cap: 3M post reads per cycle.
- **Search:** recent search covers the last 7 days, 100 posts per request. Full-archive search costs extra.
- **Storage:** stored content must be kept current, and deleted or protected content must be removed within 24 hours of a request. Source: https://docs.x.com/developer-terms/policy
- **Cost for the pilot (50 accounts × 10 posts × 2 refreshes per day × 30 days = 30,000 post reads):** about **$150 per month**, plus user reads and search.
- **Needs:** a Bearer token and prepaid credits.
- Record: [`capabilities/x.json`](capabilities/x.json)
