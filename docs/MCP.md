# MCP server

`apps/mcp` is a stdio MCP server that wraps this app's REST API (Master Plan §11.1). Every tool goes through the API, so the same policy guards, budget reservations, dedup and job tracking apply to the agent as to the web UI.

## Run it
1. Start the app (`start.bat` / `start.command`). The MCP server calls `http://127.0.0.1:<APP_PORT>` by default; set `MCP_API_URL` to point it elsewhere.
2. Register the server in your MCP client. For example, Claude Desktop (`claude_desktop_config.json`) or Claude Code (`claude mcp add`):

```json
{
  "mcpServers": {
    "social-spy": {
      "command": "node",
      "args": ["<repo>/node_modules/tsx/dist/cli.mjs", "<repo>/apps/mcp/src/main.ts"],
      "env": { "MCP_ALLOW_MUTATIONS": "false" }
    }
  }
}
```

You can also start it manually with `npm run mcp`, which uses stdio. Logs go to stderr.

## Permissions
- **Read-only by default.** With `MCP_ALLOW_MUTATIONS=false`, only these read tools are registered: `list_projects`, `get_provider_capabilities`, `get_usage`, `get_dashboard`, `list_candidates`, `get_profile`, `get_posts`, `get_post_detail`, `get_post_metrics`, `get_growth_history`, `find_viral_posts`, `find_trends`, `generate_creative_ideas` (from stored analyses; no model call), `compare_competitors`, `get_job_status`, `list_workflows`, `list_reports`, `get_report`, `get_export`.
- **Mutations are opt-in.** `MCP_ALLOW_MUTATIONS=true` adds:
  - `create_project`, `expand_keywords`, `track_account`
  - `discover_competitors`, `approve_candidates`
  - `analyze_content`, `run_workflow`, `cancel_job`
  - `export_excel`, `generate_report`

  These can spend provider or AI budget, and their descriptions say so.
- **Never exposed:** quotas and caps, data policies, credentials, project budgets, provider enablement. An agent cannot bypass a guard.
- **Untrusted content:** tool results include third-party post text. MCP clients should treat that text as data, never as instructions.

## Not provided as separate tools
`search_accounts` and `search_posts` from §11.1 are covered by `discover_competitors`, which runs the searches as a budget-checked, deduplicated job that records coverage. A direct, unbudgeted search tool would bypass that.

## Evidence
- `tests/integration/mcp-reports.test.ts`: a real MCP client over stdio checks read-only mode and the mutation gate, `generate_report` → job → report + Excel, and `export_excel` → job → file download.
- `npm run phase7:mcp` → `docs/phase7/`: the same flow with live Bluesky data.
