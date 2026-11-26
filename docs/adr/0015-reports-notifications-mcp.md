# ADR-0015: Reports, notifications, MCP and n8n

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 7

## Decisions

### 1. Reports (WF11 daily at 06:00, WF12 weekly on Monday at 08:00; job `report.generate`)
- **Contents:**
  - new tracked accounts and posts collected per account;
  - standout posts: viral-v1 when allowed, otherwise raw likes, labelled as such;
  - rising or new topics;
  - failed sources and unhealthy providers;
  - usage and cost;
  - pending candidates;
  - rule-based suggested actions;
  - links to the Content Explorer, Insights, the report and the Excel export (attached from the period).
- **Status:** any failed or partial collection run, or an unhealthy provider, makes the report `PARTIAL_SUCCESS` and says why. A failed source is never reported as "no new content".
- **Policy:** post and profile URLs are only included when the provider policy allows export. Otherwise the report gives counts and a note.
- **Settings:** `settings.daily_report` and `settings.weekly_report` (default on); `notify` decides whether the report is sent.

### 2. Notifications (`notifications` table)
- **Channels:**
  - Telegram Bot API (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`);
  - email (nodemailer 8.0.11 over `SMTP_URL`, `EMAIL_FROM`, `EMAIL_TO`);
  - webhook (`WEBHOOK_URL`, optionally signed with `WEBHOOK_SECRET`).
- **Unconfigured channel:** recorded as `SKIPPED`, not treated as an error.
- **Dedup:** unique on (channel, dedup key). A sent message is never re-sent (`DUPLICATE`). A failed one is retried at most 3 times in total. HTTP 4xx errors (except 429) are permanent and not retried.
- **Webhook signature:** `X-SSS-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` plus `X-SSS-Timestamp`. Receivers should reject timestamps older than 5 minutes; the n8n template does.
- **Secrets:** tokens, the SMTP password and the webhook secret are registered for log redaction.

### 3. MCP (`apps/mcp`, stdio, `@modelcontextprotocol/sdk` 1.32.2)
- **Thin wrapper over the REST API** (§11.1: "MCP is only a wrapper"). No collector logic is duplicated, so guards, budgets, dedup and jobs are identical for agents.
- **Read-only by default.** 10 mutation tools are registered only with `MCP_ALLOW_MUTATIONS=true`.
- **Never exposed:** quota, policy, credential and budget settings.
- **Search:** `search_accounts` and `search_posts` are deliberately covered by `discover_competitors`, which is budget-checked and records coverage. See `docs/MCP.md`.

### 4. n8n
- **Templates** in `docs/integrations/n8n/`:
  - a scheduled report through the REST API;
  - a receiver for signed notifications.
- **n8n only calls the API.** If n8n triggers reports, disable `wf11-daily-report` so schedules do not run twice (§7.1).
- **Tested:** the templates' structure and the receiver's signature code (unit test).
- **Not tested:** the templates have not been run inside an n8n instance; n8n is not installed on this machine.

## Consequences
- Telegram and email delivery are tested against local fake servers. Real delivery needs the user's bot token, chat id and SMTP settings.
- The scheduler's catch-up policy also covers reports: after downtime, one report runs, covering the last day or week.
