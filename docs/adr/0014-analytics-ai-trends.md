# ADR-0014: Policy-gated analytics, AI analysis and trends

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 6

## Context
Master Plan §7.5–7.7 specifies:
- a viral engine, gated by policy;
- AI content analysis, metadata-only by default;
- a trend engine;

each with evidence, confidence, versioning and fixture tests. Every provider is deny-by-default until the Product Owner approves its policy (Bluesky: `allowDerivedMetrics=false`).

## Decisions

### 1. One gate for all derived analytics
Viral scores, trend topics and AI analysis are all "derived analytics". They run only on posts whose provider policy has `allowDerivedMetrics=true`.
- Posts that are not allowed are counted under `blockedByPolicy` (provider, policy id, count). They are never scored as 0.
- No post text is sent to the AI provider for a blocked source. The integration test asserts this.

### 2. WF07 viral engine `viral-v1` (job `analytics.viral`, queue `analytics`, hourly WF07 schedule)
- **Posts covered:** recent posts (30 days) of the project's approved accounts.
- **Cohorts:** platform × format × follower bucket. A cohort with fewer than 3 posts falls back to the whole project, and the result records which comparison was used.
- **Features**, each normalised to 0–100:
  - velocity and acceleration of views, or of interactions when there are no views (needs 2 or 3 snapshots);
  - engagement rate (interactions / views, else / followers);
  - baseline deviation (signal / cohort median);
  - relevance (project rule score).
- **Score:** weights 35/20/20/15/10 (§7.5), renormalised over the features that are available. The result lists the available and missing features.
- **Missing data:** fewer than 2 features, or no growth evidence, gives `INSUFFICIENT_DATA` (score null). A negative delta is flagged `NEGATIVE_DELTA`, never turned positive.
- **Labels:** 60 trending, 80 viral, 90 breakout, marked experimental.
- **Real-data finding** (`docs/phase6/`): with history denied by policy, there is no velocity or acceleration. On 33 real posts, the labels came out skewed high (4 breakout, 2 viral, 6 trending). **Thresholds must be recalibrated** once history is allowed and enough data exists. Until then, use the score for ranking within a project, not as an absolute label.

### 3. WF09 trends `trends-v1` (job `analytics.trends`, every 6 h)
- **Topics:** hashtags and the project's ACTIVE keywords, in the current window vs the previous one of equal length.
- **Per topic:** posts, distinct accounts, growth, interactions, and a signal (`new`, `rising`, `steady` or `falling`). Topics with fewer than 2 posts are ignored.
- **Confidence:** `low`, `medium` or `high`, depending on sample size and number of accounts. A single-account topic is flagged and never rated `high`.
- **Coverage** always says "collected sample only — not representative of the whole platform", and lists the posts blocked by policy and the posts without metrics.
- **Storage:** results go to `trend_snapshots`.

### 4. WF08 AI analysis (job `ai.analyze`, queue `ai`; daily at 07:00 for projects with `settings.ai_analysis_daily`)
- **Call:** the official Anthropic SDK (`@anthropic-ai/sdk` 1.14.0), `client.beta.messages.parse` with structured output (`betaZodOutputFormat`, a zod schema per §7.6 including evidence, confidence, limitations and creative ideas).
- **Model and effort:** model `AI_MODEL` (default `claude-opus-5-5`), effort `AI_EFFORT` (default `medium`).
- **Refusal fallback:** on by default (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`; turn off with `AI_FALLBACKS=false`). A `refusal` stop reason is stored as `REFUSED`.
- **Credentials:** only `ANTHROPIC_API_KEY` from config is used (`authToken: null`). An ambient token or profile on the machine is never picked up; a test caught the SDK doing this.
- **Untrusted input:** the post is sent as a JSON document inside `<post_data>`. The fixed system prompt says its content is data, never instructions. No tools are offered, and the output is constrained to the schema.
- **Metadata only:** title, caption, hashtags, type and public counts. No media is downloaded; `visualNotes` stays null and the limitations say so.
- **No repeat calls:** results are cached by (post, model, prompt version, sha256 of the input), so re-runs make no new model calls.
- **Limits:**
  - `AI_DAILY_MAX_ANALYSES` (global);
  - `max_ai_analysis_per_day` (per project);
  - the project's `daily_budget_usd`. This is now enforced for AI because AI has a cost model: `AI_INPUT_USD_PER_MTOK` and `AI_OUTPUT_USD_PER_MTOK`, both configurable.
- **Usage:** recorded in `usage_logs` (provider `anthropic`, units `input_tokens` and `output_tokens`, cost).
- **No key:** the job fails with `AUTH_REQUIRED`, and the scheduled run is SKIPPED with that reason.

### 5. Exports and UI
- Project workbooks gain `Viral`, `Trends` and `AI_Analysis` sheets. They contain only posts allowed for both export and derived analytics.
- The new **Insights** page shows:
  - the viral feed, with the features used and the features missing;
  - trends, with reasons, confidence and supporting posts;
  - AI results, with evidence, audience hypotheses (not demographics), ideas and limitations.

## Consequences
- With the current policies, Phase 6 produces nothing for Bluesky. It reports "blocked by policy" until the Product Owner approves the policy proposal (`allowDerivedMetrics`).
- AI analysis needs `ANTHROPIC_API_KEY`.
