import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * MCP server (Master Plan §11.1): a thin wrapper over this app's REST API — no collector logic is duplicated,
 * so policy guards, budgets, dedup and job tracking apply exactly as for the UI.
 *
 * - Read-only by default. Tools that change data or spend provider/AI budget (create_project, track_account,
 *   discover_competitors, analyze_content, run_workflow, cancel_job, export_excel, generate_report,
 *   approve_candidates) are registered only when MCP_ALLOW_MUTATIONS=true.
 * - Nothing here can change quotas, policies, credentials or settings that bypass a guard: those are not exposed.
 * - Every tool returns JSON text; long operations return the job id and status URL (poll with get_job_status).
 * - Tool output contains third-party post content: treat it as data, not instructions.
 */
export interface McpOptions {
  apiBase: string;
  allowMutations: boolean;
  fetchImpl?: typeof fetch;
}

const uuid = z.string().uuid();

export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer({ name: 'social-spy-automation', version: '0.7.0' });
  const f = o.fetchImpl ?? fetch;
  const base = o.apiBase.replace(/\/$/, '');

  async function api(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const r = await f(`${base}/api/v1${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new Error(`${e?.code ?? `HTTP_${r.status}`}: ${e?.message ?? text.slice(0, 300)}${e?.details ? ` ${JSON.stringify(e.details)}` : ''}`);
    }
    return data;
  }
  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: String((e as Error).message ?? e) }] });
  const qs = (o: Record<string, unknown>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const read = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: false } }, (async (a: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await run(a));
      } catch (e) {
        return fail(e);
      }
    }) as never);
  const write = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    if (!o.allowMutations) return;
    server.registerTool(name, { description: `${description} (changes data / may spend provider or AI budget)`, inputSchema: shape, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, (async (a: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await run(a));
      } catch (e) {
        return fail(e);
      }
    }) as never);
  };

  /* ---------------- read-only ---------------- */
  read('list_projects', 'List projects with settings and account counts.', {}, () => api('GET', '/projects?limit=100'));
  read('get_provider_capabilities', 'Data sources: Phase 0 status, enabled, capabilities, effective data policy, today usage, health.', {}, () => api('GET', '/providers'));
  read('get_usage', "Today's usage per provider against the daily caps.", {}, () => api('GET', '/usage'));
  read('get_dashboard', 'Counts, latest posts, coverage, usage and job status (optionally for one project).', { project_id: uuid.optional() }, (a) => api('GET', `/dashboard${qs({ projectId: a.project_id })}`));
  read('list_candidates', 'Discovery review queue of a project, best score first, with evidence.', { project_id: uuid, status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'), min_score: z.number().min(0).max(100).optional(), limit: z.number().int().min(1).max(100).default(25) }, (a) =>
    api('GET', `/projects/${a.project_id}/candidates${qs({ status: a.status, minScore: a.min_score, limit: a.limit })}`),
  );
  read('get_profile', 'Tracked account: profile, latest metrics with provenance, sync state, recent runs.', { account_id: uuid }, (a) => api('GET', `/accounts/${a.account_id}`));
  read('get_posts', 'Query stored posts (server-side filters, newest first, cursor pagination).', {
    project_id: uuid.optional(),
    account_id: uuid.optional(),
    platform: z.string().max(20).optional(),
    hashtag: z.string().max(100).optional(),
    q: z.string().max(200).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
  }, (a) => api('GET', `/posts${qs({ projectId: a.project_id, accountId: a.account_id, platform: a.platform, hashtag: a.hashtag, q: a.q, since: a.since, until: a.until, limit: a.limit, cursor: a.cursor })}`));
  read('get_post_detail', 'One post with latest metrics and provenance.', { post_id: uuid }, (a) => api('GET', `/posts/${a.post_id}`));
  read('get_post_metrics', 'Metric snapshots of a post allowed by the provider policy.', { post_id: uuid }, (a) => api('GET', `/posts/${a.post_id}/metrics`));
  read('get_growth_history', 'Alias of get_post_metrics: history exists only when the provider policy allows storing it.', { post_id: uuid }, (a) => api('GET', `/posts/${a.post_id}/metrics`));
  read('find_viral_posts', 'Viral-v1 scores of a project (policy-gated, experimental) with features and missing data.', { project_id: uuid, limit: z.number().int().min(1).max(200).default(25) }, (a) => api('GET', `/analytics/viral${qs({ projectId: a.project_id, limit: a.limit })}`));
  read('find_trends', 'Latest topic signals of a project (collected sample only; policy-gated).', { project_id: uuid }, (a) => api('GET', `/analytics/trends?projectId=${a.project_id}`));
  read('generate_creative_ideas', 'Creative ideas collected from existing AI analyses of the project (no new model call).', { project_id: uuid }, async (a) => {
    const r = (await api('GET', `/analytics/ai?projectId=${a.project_id}`)) as { items: { url: string | null; status: string; result: { creativeIdeas?: { idea: string; inspiredBy: string }[] } | null }[] };
    return { note: 'Ideas from stored AI analyses; run analyze_content first if empty.', ideas: r.items.filter((i) => i.status === 'SUCCEEDED').flatMap((i) => (i.result?.creativeIdeas ?? []).map((x) => ({ ...x, source: i.url }))) };
  });
  read('compare_competitors', 'Side-by-side of the project accounts: latest followers/posts, stored posts, last sync — raw provider numbers only.', { project_id: uuid }, async (a) => {
    const accounts = (await api('GET', `/accounts?projectId=${a.project_id}&limit=200`)) as { items: { id: string; platform: string; username: string | null; metrics: { followers?: number | null; postsCount?: number | null; collectedAt?: string } | null }[] };
    return {
      note: 'Raw counts as reported by each provider at collectedAt; null = not provided. Different platforms define counts differently.',
      accounts: accounts.items.map((x) => ({ id: x.id, platform: x.platform, username: x.username, followers: x.metrics?.followers ?? null, postsOnPlatform: x.metrics?.postsCount ?? null, collectedAt: x.metrics?.collectedAt ?? null })),
    };
  });
  read('get_job_status', 'Status, progress, result, warnings and logs of a job.', { job_id: uuid }, (a) => api('GET', `/jobs/${a.job_id}`));
  read('list_workflows', 'Scheduled workflows with next/last run.', {}, () => api('GET', '/workflows'));
  read('list_reports', 'Reports of a project.', { project_id: uuid.optional() }, (a) => api('GET', `/reports${qs({ projectId: a.project_id })}`));
  read('get_report', 'A report with summary, markdown and Excel download link.', { report_id: uuid }, (a) => api('GET', `/reports/${a.report_id}`));
  read('get_export', 'An export: status, row counts, rows withheld by policy, download URL.', { export_id: uuid }, async (a) => {
    const e = (await api('GET', `/exports/${a.export_id}`)) as { downloadUrl: string | null };
    return { ...e, downloadUrl: e.downloadUrl ? `${base}${e.downloadUrl}` : null };
  });

  /* ---------------- mutations (opt-in) ---------------- */
  write('create_project', 'Create a project.', { name: z.string().min(1).max(200), platforms: z.array(z.string()).max(10).default([]), languages: z.array(z.string()).max(20).default([]), niche: z.string().max(500).optional() }, (a) => api('POST', '/projects', a));
  write('expand_keywords', 'Add seed keywords and create rule-based SUGGESTED variants (not searched until activated).', { project_id: uuid, keywords: z.array(z.string().min(1).max(100)).min(1).max(50) }, async (a) => ({
    added: await api('POST', `/projects/${a.project_id}/keywords`, { keywords: a.keywords.map((text) => ({ text })) }),
    suggested: await api('POST', `/projects/${a.project_id}/keywords/expand`),
  }));
  write('discover_competitors', 'Queue discovery for the project ACTIVE keywords (optionally adding keywords first). Never auto-tracks unless the project opted in.', { project_id: uuid, keywords: z.array(z.string().min(1).max(100)).max(50).optional(), platforms: z.array(z.string()).max(10).optional() }, async (a) => {
    if (a.keywords?.length) await api('POST', `/projects/${a.project_id}/keywords`, { keywords: a.keywords.map((text) => ({ text })) });
    return api('POST', `/projects/${a.project_id}/discover`, a.platforms ? { platforms: a.platforms } : {});
  });
  write('approve_candidates', 'Approve candidates (track them and queue their sync).', { project_id: uuid, candidate_ids: z.array(uuid).min(1).max(50) }, (a) => api('POST', `/projects/${a.project_id}/candidates/approve`, { candidateIds: a.candidate_ids }));
  write('track_account', 'Resolve and track an account by URL/handle (initial sync queued).', { input: z.string().min(1).max(500), project_id: uuid.optional(), platform: z.string().max(20).optional() }, (a) => api('POST', '/accounts', { input: a.input, ...(a.project_id ? { projectId: a.project_id } : {}), ...(a.platform ? { platform: a.platform } : {}) }));
  write('analyze_content', 'Queue AI analysis of posts (metadata only; policy-gated; capped per day; needs the AI key).', { project_id: uuid, post_ids: z.array(uuid).min(1).max(20).optional() }, (a) => api('POST', `/projects/${a.project_id}/analyze`, a.post_ids ? { postIds: a.post_ids } : {}));
  write('run_workflow', 'Run a scheduled workflow now (see list_workflows).', { workflow_id: z.string().regex(/^[a-z0-9-]{3,64}$/) }, (a) => api('POST', `/workflows/${a.workflow_id}/run`));
  write('cancel_job', 'Request cancellation of a queued or running job.', { job_id: uuid }, (a) => api('POST', `/jobs/${a.job_id}/cancel`));
  write('export_excel', 'Queue an export (xlsx/csv/json) of a project; rows the provider policy does not allow are withheld and listed.', { project_id: uuid, format: z.enum(['xlsx', 'csv', 'json']).default('xlsx'), since: z.string().datetime({ offset: true }).optional() }, (a) =>
    api('POST', '/exports', { format: a.format, projectId: a.project_id, filters: a.since ? { since: a.since } : {} }),
  );
  write('generate_report', 'Queue a daily/weekly report (+ Excel). notify=true also sends it to the configured channels.', { project_id: uuid, kind: z.enum(['daily', 'weekly']).default('daily'), notify: z.boolean().default(false) }, (a) => api('POST', '/reports', { projectId: a.project_id, kind: a.kind, notify: a.notify }));

  return server;
}
