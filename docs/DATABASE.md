# Database

**Engine:** PostgreSQL 17, with UTF-8 encoding and the ICU `und` locale. In native mode it runs embedded; in Docker mode it uses the `postgres:17-alpine` image.

**Schema and migrations:** the schema is [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma), managed with Prisma 7 migrations.

## Rules (Master Plan §6.1)
- **IDs.** Internal IDs are UUIDs. External IDs are stored as text and are unique per `(platform, external_id)` within each entity table.
- **Time.** Every column is `timestamptz` and is stored in UTC. The UI shows times in the project's or app's timezone (default `Asia/Ho_Chi_Minh`).
- **NULL means unknown.** NULL is used when a value is missing, unsupported or not provided. It is never replaced by 0. The reason is kept in `missing` JSON on metric rows.
- **Separate timestamps.** `published_at`, `first_seen_at`, `last_collected_at`, `collected_at` (metrics) and `updated_at` are kept distinct.
- **Provenance.** Every collected row carries `provider_id`, `policy_id` and `schema_version`.

## Tables (Phase 1)

### Projects and competitors
| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `projects` | Projects, budgets, and `settings` (`project_defaults`, §9.1) | |
| `competitors` | Competitor brands (populated from Phase 3) | |
| `competitor_accounts` | Links a brand to an account, with evidence | PK `(competitor_id, account_id)` |

### Accounts and content
| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `social_accounts` | Accounts on each platform, with status `ACTIVE`, `NOT_FOUND` or `PRIVATE_OR_REMOVED` | unique `(platform, external_id)` |
| `project_accounts` | Tracking link between a project and an account: approval, tracking status, priority, sync state | PK `(project_id, account_id)`; indexes `(project_id, approval_status)` and `(next_sync_at)` |
| `posts` | Posts. Phase 2 adds `provider_indexed_at` (Bluesky `indexedAt`; `published_at` is author-supplied), `last_metrics_at`, and `unavailable_at` / `unavailable_reason` for posts the provider stopped returning (`status = UNAVAILABLE`; a later sync that returns the post sets it back to `AVAILABLE`) | unique `(platform, external_id)`; indexes `(account_id, published_at DESC)`, `(sort_at DESC, id DESC)`, `(account_id, sort_at DESC, id DESC)`, `(status, last_metrics_at)` |
| `post_metrics` | Metric snapshots for posts. Only the latest one is kept unless the policy allows history | index `(post_id, collected_at DESC)` |
| `account_metrics` | Account metric snapshots, with the same policy rule | index `(account_id, collected_at DESC)` |

### Providers and policies
| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `providers` | Seeded from `docs/feasibility/capabilities/*.json`. `credential_ref` names the env var that holds the key; the secret value is never stored | |
| `data_policies` | The effective policy for each provider (deny by default) | |

### Jobs and collection runs
| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `jobs` | Job state (the source of truth) | **partial unique index on `idempotency_key` WHERE status IN (QUEUED, RUNNING)** |
| `job_logs` | Redacted log lines for each job | |
| `collection_runs` | One row per provider operation: request count, record count, quota units, cost, latency, error | |
| `sync_cursors` | Checkpoint per `(account, provider)`: cursor, watermark, `backfill_done` | |
| `usage_logs` | Usage per provider and per UTC day (Phase 1 quota guard) | index `(provider_id, day)` |

### Keywords and discovery (Phase 3)
| Table | Purpose | Key constraints and indexes |
|---|---|---|
| `keywords` | Project keywords: `normalized_text` (NFKC, lower-case, no `#`), `origin` MANUAL/RULE/AI, `status` SUGGESTED/ACTIVE/PAUSED/REJECTED (only ACTIVE is searched), `parent_id` for expansions | unique `(project_id, normalized_text)`; index `(project_id, status)` |
| `discovery_candidates` | Review queue: account, rule score 0–100, classification, `evidence` JSON (reasons, matched keywords, sources, sample post URLs, profile snapshot), approval status, who decided and when | unique `(project_id, account_id)`; index `(project_id, approval_status, score DESC)` |
| `search_results` | Every search hit per keyword/provider/job (rank, account and post external IDs, URL). Post hits are not stored as posts until the account is approved | indexes `(project_id, collected_at DESC)`, `(keyword_id)` |

### Operations
| Table | Purpose |
|---|---|
| `schedules` | Workflow schedules. The DB-driven tick claims due rows atomically (ADR-0012); `last_status` / `last_result` record each run |
| `app_settings` | Runtime switches such as `scheduler = {paused}`. Never secrets |
| `usage_reservations` | Budget reservations (authorize → reserve → execute → reconcile). They count until they are settled or expire. Granting takes an advisory lock per (provider, unit, day) |
| `audit_logs` | Actions such as `project.create/update/delete`, `account.track`, `account.tracking` and `candidate.approved/rejected`, with redacted metadata |

**Tables in Master Plan §6.2 that arrive in later phases:**
- `keyword_groups`
- `post_media`, `comments` and `raw_responses`
- `viral_scores`, `trends` / `trend_snapshots`, `content_analysis` and `creative_ideas`
- `workflows` / `workflow_versions` and `workflow_runs`
- `credentials` (a secret store) and `notifications` / `reports`

## Cascades
- Deleting a project removes its `project_accounts` rows. Accounts and posts are shared across projects, so they are kept; orphan cleanup comes in Phase 4 (WF14).
- Deleting an account removes its posts, metrics, cursors and project links.

## Working with migrations
| Task | Command |
|---|---|
| Create a migration after editing `schema.prisma` | `npm run db:migrate:new -- <snake_case_name>` (uses a throwaway embedded Postgres; no setup needed) |
| Apply migrations | Applied automatically by `start` and by the Docker `migrate` service. Manually: `npx tsx tools/local/src/migrate-seed.ts` with `DATABASE_URL` set |
| Regenerate the client | `npm run db:generate` (this also runs on `npm ci`) |

> **Warning:** the partial unique index lives in a hand-written migration (`*_jobs_active_dedup`). If `prisma migrate dev` ever proposes dropping `jobs_active_idempotency_key`, remove that statement from the generated migration before committing it.
