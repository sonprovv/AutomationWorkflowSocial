# ADR-0011: Keyword discovery, rule scoring and the review queue

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 3

## Context
Master Plan §7.3 (WF01–02) asks for keyword expansion, fan-out search per platform, account extraction and enrichment, a 0–100 relevance score with evidence, a classification, and a review queue where nothing is added automatically unless the user opts in. AI is not configured yet (Phase 6), and the plan allows "manual or rule-based mode".

## Decisions

### 1. Keywords
- Dedup key: `normalized_text` (NFKC, trimmed, leading `#` removed, single spaces, lower-case), unique per project.
- WF01 rule mode derives variants only from the user's own text: the compact form ("live wallpaper" → "livewallpaper") and the English singular/plural of the last word. Plural rules are applied only when the keyword language is English or unset.
- Expansions are `SUGGESTED` and are **not searched** until the user activates them.

### 2. Discovery (WF02), job `project.discover`, queue `discovery`
- ACTIVE keywords (at most `max_keywords_per_run`, priority first) × the project platforms.
- Per platform: no collector, provider disabled, a capability that is not SUPPORTED/PARTIAL, or no budget → a `SKIPPED` coverage entry with the reason.
- Per keyword: page 1 of `searchAccounts` and of `searchPosts` (`max_results_per_search`, at most 100; the first project language and market are passed as hints). The usage meter checks the budget before every call. A failed call is an `ERROR` coverage entry with the typed code; it is never counted as "0 results". `BUDGET_EXCEEDED` or `QUOTA_EXCEEDED` stops further calls for that provider in the run.
- Post authors and account-search hits are aggregated per account. Up to 30 profiles per provider per run are enriched with `getProfile` (search snippets lack counts), strongest candidates first. Post-only authors beyond that cap are counted as `notEnriched` and not stored.
- Every hit is kept in `search_results` for audit. Posts found by search are not stored as posts; only their URL and a 200-character snippet go into the candidate evidence.
- Accounts already linked to the project are counted as `alreadyTracked` and get no candidate row.
- Status: all searches failed → the first error is thrown (the job retry policy applies). Some failed → `PARTIAL_SUCCESS`. Nothing could be searched → `SKIPPED`.

### 3. Rule score `rule-v1` (no AI, observable evidence only)
| Signal | Points |
|---|---|
| Keyword in handle or display name (compact forms match inside handles) | 20, +5 per extra keyword, max 30 |
| Keyword in bio | 12, +4 per extra keyword, max 20 |
| Own posts returned by post search | 10 per post, max 30 |
| Best account-search rank | up to 15, scaled by rank |
| Matched by 2 or more distinct keywords | +5 |

The classification is a heuristic based on the account's own profile text and is always marked `confidence: "low"`:
- score < 20 → `IRRELEVANT`;
- news/media words → `PUBLISHER`;
- creator words → `CREATOR`;
- keyword in the name plus brand words → `DIRECT_COMPETITOR`;
- other keyword matches → `ADJACENT_COMPETITOR`;
- anything else → `UNKNOWN`.

Followers, country or market are not used and not inferred (§6.1, §10.1).

### 4. Review queue
- New candidates are `PENDING`. A re-run updates score and evidence but never overwrites a human decision.
- Approve: the project link becomes `APPROVED`/`TRACKING` with `relevance_score = score`, and the initial sync is queued. Approvals are refused (409) if they would exceed `max_accounts`.
- Reject: the candidate becomes `REJECTED`. A previously approved link is paused; its data is kept.
- Every decision is written to `audit_logs`.
- **Auto-track is opt-in** (`settings.auto_track`, default `false`). When on, it approves only candidates from this run with score ≥ `auto_track_min_score` (default 70), at most `auto_track_max_per_run` (default 5), within `max_accounts`. These decisions are recorded with `decided_by = auto`.

## Consequences
- The score is explainable: `evidence.reasons` lists every contribution. It is versioned so that Phase 6 (AI) can add a new version without rewriting history.
- The classification is a weak hint; people review every candidate.
- Real run (2026-11-26): 2 keywords on Bluesky gave 115 hits, 67 candidates and 34 requests. YouTube and TikTok were reported as SKIPPED with their reasons (`docs/phase3/discovery/`).
