import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { findRepoRoot } from '@sss/config';
import type { Export, Prisma } from '@sss/database';
import { getEffectivePolicy, type EffectivePolicy } from '@sss/policy-engine';
import { idempotencyKey, JOB_NAMES } from '@sss/queue';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { JobService } from './jobs.ts';
import { postQuerySchema, postWhere } from './posts.ts';
import { iso, num } from './serialize.ts';
import { buildCsv, buildXlsx, neutralizeFormula, type Cell, type Sheet } from './xlsx.ts';

export const EXPORT_FORMATS = ['xlsx', 'csv', 'json'] as const;

export const exportRequestSchema = z
  .object({
    format: z.enum(EXPORT_FORMATS).default('xlsx'),
    projectId: z.uuid().optional(),
    filters: postQuerySchema.omit({ limit: true, cursor: true, projectId: true }).default({}),
  })
  .strict();

export function exportDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(findRepoRoot(), dir);
}

export function toExportView(e: Export) {
  return {
    id: e.id,
    projectId: e.projectId,
    format: e.format,
    status: e.status,
    filters: e.filters,
    rowCounts: e.rowCounts,
    withheld: e.withheld,
    fileName: e.fileName,
    sizeBytes: e.sizeBytes,
    jobId: e.jobId,
    error: e.error,
    createdAt: e.createdAt.toISOString(),
    finishedAt: iso(e.finishedAt),
    expiresAt: e.expiresAt.toISOString(),
    downloadUrl: e.status === 'SUCCEEDED' ? `/api/v1/exports/${e.id}/download` : null,
  };
}

/** Rows per query when building exports (keeps bind parameters well under PostgreSQL's 32,767 limit). */
const EXPORT_BATCH = 5000;

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** Data dictionary rows: sheet, column, meaning, source, when null. */
const DICTIONARY: [string, string, string, string, string][] = [
  ['Accounts', 'platform', 'Platform of the account', 'collector', '—'],
  ['Accounts', 'external_id', 'Stable platform ID (YouTube channel ID, Bluesky DID)', 'provider', '—'],
  ['Accounts', 'username / display_name', 'Handle and display name at collection time', 'provider', 'not provided by the provider'],
  ['Accounts', 'profile_url', 'Public profile link', 'collector', '—'],
  ['Accounts', 'followers / following / posts_count', 'Counts reported by the provider at metrics_collected_at', 'provider', 'missing: see missing_reason (never replaced by 0)'],
  ['Accounts', 'approval / tracking / relevance', 'Project link: review decision, tracking state, rule score (rule-v1, 0–100)', 'this system', 'account not linked to the project'],
  ['Posts', 'published_at', 'Publish time reported by the platform (Bluesky: author-supplied createdAt, may be backdated)', 'provider', 'not provided'],
  ['Posts', 'provider_indexed_at', 'Provider index time (Bluesky indexedAt)', 'provider', 'provider has no index time (YouTube)'],
  ['Posts', 'url', 'Original post link', 'collector', '—'],
  ['Posts', 'views / likes / comments / shares / saves', 'Public counters at metrics_collected_at. Definitions differ per platform; do not mix platforms without care', 'provider', 'missing: see missing_reason (NOT_SUPPORTED, HIDDEN_BY_OWNER, DISABLED, NOT_PROVIDED)'],
  ['Posts', 'extra_metrics', 'Platform-specific counters (e.g. Bluesky quotes), JSON', 'provider', '—'],
  ['Posts', 'thumbnail_url', 'Thumbnail link, only when the provider policy allows media', 'provider', 'policy does not allow media, or not provided'],
  ['Posts', 'status', 'AVAILABLE, or UNAVAILABLE when the provider stopped returning the post', 'this system', '—'],
  ['Posts', 'provider / policy_id / schema_version', 'Provenance of the row', 'this system', '—'],
  ['Keywords', 'status / origin', 'SUGGESTED keywords are not searched; origin MANUAL / RULE / AI', 'this system', '—'],
  ['Collection_Log', '*', 'One row per provider operation (requests, records, quota units, latency, error)', 'this system', '—'],
  ['Usage', '*', 'Usage per provider, UTC day and unit', 'this system', '—'],
];

/**
 * WF17 exports (Master Plan §12) with the policy guard (§9.2): rows from a provider whose effective policy does
 * not allow export are WITHHELD and listed in Summary/withheld — never silently dropped. Text from external
 * sources is formula-neutralized. Files are written to EXPORT_DIR and expire after EXPORT_TTL_DAYS (WF14).
 */
export class ExportService {
  constructor(private readonly ctx: ServiceContext) {}

  private dir() {
    const d = exportDir(this.ctx.config.EXPORT_DIR);
    mkdirSync(d, { recursive: true });
    return d;
  }

  async request(input: unknown) {
    const v = exportRequestSchema.parse(input ?? {});
    if (v.projectId && !(await this.ctx.db.project.findUnique({ where: { id: v.projectId }, select: { id: true } }))) {
      throw new AppError('NOT_FOUND', `Project ${v.projectId} not found`);
    }
    const now = nowOf(this.ctx);
    const row = await this.ctx.db.export.create({
      data: {
        projectId: v.projectId ?? null,
        format: v.format,
        filters: { ...v.filters, timezone: this.ctx.config.APP_TIMEZONE } as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + this.ctx.config.EXPORT_TTL_DAYS * 86400_000),
      },
    });
    const job = await new JobService(this.ctx).create({
      name: JOB_NAMES.EXPORT,
      payload: { exportId: row.id },
      idempotencyKey: idempotencyKey({ op: JOB_NAMES.EXPORT, resource: row.id }),
      projectId: v.projectId ?? null,
      resourceType: 'export',
      resourceId: row.id,
    });
    const updated = await this.ctx.db.export.update({ where: { id: row.id }, data: { jobId: job.id } });
    return { export: toExportView(updated), job };
  }

  /** Create and build an export in the current job (used by reports). */
  async generateNow(input: unknown) {
    const v = exportRequestSchema.parse(input ?? {});
    const now = nowOf(this.ctx);
    const row = await this.ctx.db.export.create({
      data: { projectId: v.projectId ?? null, format: v.format, filters: { ...v.filters, timezone: this.ctx.config.APP_TIMEZONE } as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + this.ctx.config.EXPORT_TTL_DAYS * 86400_000) },
    });
    return (await this.generate(row.id)).export;
  }

  async list(limit = 50) {
    const rows = await this.ctx.db.export.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
    return rows.map(toExportView);
  }

  async get(id: string) {
    const e = await this.ctx.db.export.findUnique({ where: { id } });
    if (!e) throw new AppError('NOT_FOUND', `Export ${id} not found`);
    return e;
  }

  /** Path + headers for download; refuses unfinished or expired exports. */
  async fileFor(id: string): Promise<{ path: string; fileName: string; contentType: string }> {
    const e = await this.get(id);
    if (e.status !== 'SUCCEEDED' || !e.fileName) throw new AppError('CONFLICT', `Export is ${e.status}`);
    if (e.expiresAt < nowOf(this.ctx)) throw new AppError('NOT_FOUND', 'Export expired');
    return { path: join(this.dir(), `${e.id}.${e.format}`), fileName: e.fileName, contentType: MIME[e.format]! };
  }

  /** Job body. */
  async generate(exportId: string) {
    const e = await this.get(exportId);
    await this.ctx.db.export.update({ where: { id: e.id }, data: { status: 'RUNNING' } });
    try {
      const out = await this.build(e);
      const file = join(this.dir(), `${e.id}.${e.format}`);
      writeFileSync(file, out.buffer);
      const project = e.projectId ? await this.ctx.db.project.findUnique({ where: { id: e.projectId }, select: { name: true } }) : null;
      const slug = (project?.name ?? 'all').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'export';
      const fileName = `sss-${slug}-${nowOf(this.ctx).toISOString().slice(0, 10)}.${e.format}`;
      const done = await this.ctx.db.export.update({
        where: { id: e.id },
        data: { status: 'SUCCEEDED', fileName, sizeBytes: statSync(file).size, rowCounts: out.rowCounts, withheld: out.withheld as Prisma.InputJsonValue, finishedAt: nowOf(this.ctx) },
      });
      return { export: toExportView(done), warnings: out.warnings };
    } catch (err) {
      await this.ctx.db.export.update({ where: { id: e.id }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 2000), finishedAt: nowOf(this.ctx) } });
      throw err;
    }
  }

  /** Phase 6 sheets, limited to exported posts whose policy also allows derived analytics. */
  private async analyticsSheets(projectId: string, postIds: Set<string>): Promise<Sheet[]> {
    const { db } = this.ctx;
    const ids = [...postIds];
    // Filter by project in SQL and by post id in memory: no unbounded IN lists.
    const scores = (await db.viralScore.findMany({ where: { projectId }, orderBy: { score: { sort: 'desc', nulls: 'last' } } })).filter((v) => postIds.has(v.postId));
    const analyses = (await db.contentAnalysis.findMany({ where: { projectId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } })).filter((a) => postIds.has(a.postId));
    const needed = [...new Set([...scores.map((v) => v.postId), ...analyses.map((a) => a.postId)])];
    const urls = new Map<string, string>();
    for (let i = 0; i < needed.length; i += EXPORT_BATCH) {
      for (const p of await db.post.findMany({ where: { id: { in: needed.slice(i, i + EXPORT_BATCH) } }, select: { id: true, url: true } })) urls.set(p.id, p.url);
    }
    // Trend topics summarise post data: only included when some exported posts are cleared for derived analytics.
    const trend = ids.length ? await db.trendSnapshot.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } }) : null;
    const t = (x: unknown) => (typeof x === 'string' ? neutralizeFormula(x) : x === null || x === undefined ? null : neutralizeFormula(JSON.stringify(x)));
    return [
      {
        name: 'Viral',
        rows: [
          ['url', 'status', 'score', 'label', 'version', 'available_features', 'missing_features', 'policy_id', 'scored_at'],
          ...scores.map((v): Cell[] => {
            const f = v.features as { available?: string[]; missing?: string[] };
            return [{ url: urls.get(v.postId) ?? '' }, v.status, v.score, v.label, v.version, (f.available ?? []).join(' '), (f.missing ?? []).join(' '), v.policyId, iso(v.scoredAt)];
          }),
        ],
      },
      {
        name: 'Trends',
        rows: [
          ['topic', 'kind', 'signal', 'posts_now', 'posts_prev', 'accounts_now', 'growth', 'confidence', 'reasons'],
          ...((trend?.topics ?? []) as { topic: string; kind: string; signal: string; postsNow: number; postsPrev: number; accountsNow: number; growth: number | null; confidence: string; reasons: string[] }[]).map((x): Cell[] => [t(x.topic), x.kind, x.signal, x.postsNow, x.postsPrev, x.accountsNow, x.growth, x.confidence, t(x.reasons.join('; '))]),
        ],
      },
      {
        name: 'AI_Analysis',
        rows: [
          ['url', 'model', 'prompt_version', 'scope', 'confidence', 'category', 'hook', 'key_message', 'cta', 'limitations', 'created_at'],
          ...analyses.map((a): Cell[] => {
            const r = (a.result ?? {}) as Record<string, unknown>;
            return [{ url: urls.get(a.postId) ?? '' }, a.model, a.promptVersion, a.scope, a.confidence, t(r.category), t(r.hook), t(r.keyMessage), t(r.cta), t((r.limitations as string[] | undefined)?.join('; ')), iso(a.createdAt)];
          }),
        ],
      },
    ];
  }

  /** WF14: delete expired export files and rows. */
  async purgeExpired(): Promise<number> {
    const now = nowOf(this.ctx);
    const rows = await this.ctx.db.export.findMany({ where: { expiresAt: { lt: now } } });
    for (const r of rows) rmSync(join(this.dir(), `${r.id}.${r.format}`), { force: true });
    await this.ctx.db.export.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return rows.length;
  }

  private async build(e: Export) {
    const { db, config } = this.ctx;
    const { timezone: _tz, ...stored } = e.filters as Record<string, unknown>;
    const filters = postQuerySchema.omit({ limit: true, cursor: true }).parse({ ...stored, ...(e.projectId ? { projectId: e.projectId } : {}) });
    const generatedAt = nowOf(this.ctx);
    const t = (s: string | null | undefined): string | null => (s === null || s === undefined ? null : neutralizeFormula(s));

    // Policy per provider.
    const providers = await db.provider.findMany({ select: { id: true, status: true, enabled: true } });
    const policies = new Map<string, EffectivePolicy>();
    for (const p of providers) policies.set(p.id, await getEffectivePolicy(db, p.id));
    const allowed = (providerId: string) => policies.get(providerId)?.allowExport === true;
    const withheld = new Map<string, { providerId: string; policyId: string; accounts: number; posts: number; reason: string }>();
    const hold = (providerId: string, kind: 'accounts' | 'posts') => {
      const p = policies.get(providerId);
      const w = withheld.get(providerId) ?? { providerId, policyId: p?.policyId ?? `${providerId}:deny-all`, accounts: 0, posts: 0, reason: 'Effective data policy does not allow export (allowExport=false; deny-by-default until the policy is approved)' };
      w[kind] += 1;
      withheld.set(providerId, w);
    };

    // Posts.
    // Keyset batches: bounded memory per query and never more bind parameters than PostgreSQL allows
    // (a single findMany with an include over 50k rows exceeds the 32,767-parameter limit).
    const baseWhere = postWhere(filters);
    const postRows: Awaited<ReturnType<typeof fetchBatch>> = [];
    async function fetchBatch(after: { sortAt: Date; id: string } | null, take: number) {
      return db.post.findMany({
        where: after ? { AND: [baseWhere, { OR: [{ sortAt: { lt: after.sortAt } }, { sortAt: after.sortAt, id: { lt: after.id } }] }] } : baseWhere,
        orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
        take,
        include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, account: { select: { username: true, platform: true } } },
      });
    }
    for (let after: { sortAt: Date; id: string } | null = null; postRows.length <= config.EXPORT_MAX_POSTS; ) {
      const batch = await fetchBatch(after, Math.min(EXPORT_BATCH, config.EXPORT_MAX_POSTS + 1 - postRows.length));
      postRows.push(...batch);
      if (batch.length === 0 || postRows.length > config.EXPORT_MAX_POSTS) break;
      const last = batch[batch.length - 1]!;
      after = { sortAt: last.sortAt, id: last.id };
    }
    const warnings: string[] = [];
    if (postRows.length > config.EXPORT_MAX_POSTS) {
      postRows.length = config.EXPORT_MAX_POSTS;
      warnings.push(`Truncated to EXPORT_MAX_POSTS=${config.EXPORT_MAX_POSTS} newest posts; narrow the filters for the rest.`);
    }
    const posts = postRows.filter((p) => (allowed(p.providerId) ? true : (hold(p.providerId, 'posts'), false)));

    // Accounts: project accounts, or the authors of the exported posts.
    const accountWhere: Prisma.SocialAccountWhereInput = e.projectId ? { projects: { some: { projectId: e.projectId } } } : { id: { in: [...new Set(postRows.map((p) => p.accountId))] } };
    const accountRows = await db.socialAccount.findMany({
      where: accountWhere,
      include: { metrics: { orderBy: { collectedAt: 'desc' }, take: 1 }, projects: e.projectId ? { where: { projectId: e.projectId } } : false },
      orderBy: { firstSeenAt: 'asc' },
      take: 10_000,
    });
    const accounts = accountRows.filter((a) => (allowed(a.providerId) ? true : (hold(a.providerId, 'accounts'), false)));

    const keywords = e.projectId ? await db.keyword.findMany({ where: { projectId: e.projectId }, orderBy: [{ status: 'asc' }, { priority: 'desc' }] }) : [];
    const runs = await db.collectionRun.findMany({
      where: e.projectId ? { OR: [{ job: { projectId: e.projectId } }, { accountId: { in: accountRows.map((a) => a.id) } }] } : {},
      orderBy: { startedAt: 'desc' },
      take: 1000,
    });
    const usage = await db.usageLog.groupBy({ by: ['providerId', 'day', 'unit'], _sum: { quantity: true }, orderBy: [{ day: 'desc' }], ...(e.projectId ? { where: { projectId: e.projectId } } : {}) });
    const project = e.projectId ? await db.project.findUnique({ where: { id: e.projectId } }) : null;

    const accountTable: Cell[][] = [
      ['platform', 'external_id', 'username', 'display_name', 'profile_url', 'status', 'followers', 'following', 'posts_count', 'missing_reason', 'metrics_collected_at', 'provider', 'policy_id', ...(e.projectId ? ['approval', 'tracking', 'relevance'] : [])],
      ...accounts.map((a) => {
        const m = a.metrics[0];
        const link = (a as { projects?: { approvalStatus: string; trackingStatus: string; relevanceScore: number | null }[] }).projects?.[0];
        return [
          a.platform,
          a.externalId,
          t(a.username),
          t(a.displayName),
          { url: a.profileUrl },
          a.status,
          num(m?.followers ?? null),
          num(m?.following ?? null),
          num(m?.postsCount ?? null),
          m && Object.keys(m.missing as object).length ? JSON.stringify(m.missing) : null,
          iso(m?.collectedAt ?? null),
          a.providerId,
          a.policyId,
          ...(e.projectId ? [link?.approvalStatus ?? null, link?.trackingStatus ?? null, link?.relevanceScore ?? null] : []),
        ];
      }),
    ];
    const postTable: Cell[][] = [
      ['platform', 'account', 'title', 'caption', 'published_at', 'provider_indexed_at', 'url', 'content_type', 'hashtags', 'language', 'views', 'likes', 'comments', 'shares', 'saves', 'extra_metrics', 'missing_reason', 'metrics_collected_at', 'thumbnail_url', 'status', 'provider', 'policy_id', 'schema_version'],
      ...posts.map((p) => {
        const m = p.metrics[0];
        const media = policies.get(p.providerId)?.allowMediaProcessing === true;
        return [
          p.platform,
          t(p.account.username),
          t(p.title),
          t(p.caption),
          iso(p.publishedAt),
          iso(p.providerIndexedAt),
          { url: p.url },
          p.contentType,
          t(p.hashtags.map((h) => `#${h}`).join(' ')),
          p.language,
          num(m?.views ?? null),
          num(m?.likes ?? null),
          num(m?.comments ?? null),
          num(m?.shares ?? null),
          num(m?.saves ?? null),
          m && Object.keys(m.extra as object).length ? JSON.stringify(m.extra) : null,
          m && Object.keys(m.missing as object).length ? JSON.stringify(m.missing) : null,
          iso(m?.collectedAt ?? null),
          media && p.thumbnailUrl ? { url: p.thumbnailUrl } : null,
          p.status,
          p.providerId,
          p.policyId,
          p.schemaVersion,
        ];
      }),
    ];
    const withheldList = [...withheld.values()];
    const rowCounts = { accounts: accounts.length, posts: posts.length, keywords: keywords.length, collectionRuns: runs.length };

    if (e.format === 'json') {
      const toObj = (table: Cell[][]) => table.slice(1).map((r) => Object.fromEntries((table[0] as string[]).map((h, i) => [h, typeof r[i] === 'object' && r[i] !== null && 'url' in (r[i] as object) ? (r[i] as { url: string }).url : r[i] ?? null])));
      const body = {
        meta: { schema: 'sss.export/v1', generatedAt: generatedAt.toISOString(), timezone: config.APP_TIMEZONE, project: project ? { id: project.id, name: project.name } : null, filters, rowCounts, withheld: withheldList, warnings },
        dataDictionary: DICTIONARY.map(([sheet, column, meaning, source, whenNull]) => ({ sheet, column, meaning, source, whenNull })),
        accounts: toObj(accountTable),
        posts: toObj(postTable),
        keywords: keywords.map((k) => ({ text: k.text, status: k.status, origin: k.origin, language: k.language })),
      };
      return { buffer: Buffer.from(JSON.stringify(body, null, 2)), rowCounts, withheld: withheldList, warnings };
    }
    if (e.format === 'csv') {
      if (withheldList.length) warnings.push('CSV contains posts only; withheld rows are listed in the export record.');
      return { buffer: buildCsv(postTable), rowCounts: { posts: posts.length }, withheld: withheldList, warnings };
    }

    const summary: Cell[][] = [
      ['Field', 'Value'],
      ['Report', 'Social Spy Automation export'],
      ['Generated at (UTC)', generatedAt.toISOString()],
      ['Display timezone', config.APP_TIMEZONE],
      ['Project', project?.name ?? '(all data)'],
      ['Filters', JSON.stringify(filters)],
      ['Time range (published)', `${filters.since ?? 'any'} → ${filters.until ?? 'any'}`],
      ['Rows', JSON.stringify(rowCounts)],
      ['Missing values', 'Empty cells mean missing/not supported (see missing_reason); they are never 0.'],
      ['Coverage', providers.map((p) => `${p.id}: ${p.status}${p.enabled ? '' : ' (not enabled)'}`).join('; ')],
      ...withheldList.map((w): Cell[] => [`Withheld: ${w.providerId}`, `${w.posts} post(s), ${w.accounts} account(s) — ${w.reason} [${w.policyId}]`]),
      ['Not included', 'Metrics_History unless the provider policy allows history. Viral / Trends / AI_Analysis contain only rows whose provider policy allows both export and derived analytics.'],
      ...warnings.map((w): Cell[] => ['Warning', w]),
    ];
    const sheets: Sheet[] = [
      { name: 'Summary', rows: summary, widths: [28, 120] },
      { name: 'Accounts', rows: accountTable, widths: [10, 34, 26, 26, 40, 10, 11, 11, 11, 30, 24, 18, 28] },
      { name: 'Posts', rows: postTable, widths: [10, 24, 30, 60, 24, 24, 50, 10, 24, 8, 9, 9, 9, 9, 9, 18, 30, 24, 30, 12, 18, 28, 24] },
      ...(e.projectId ? [{ name: 'Keywords', rows: [['text', 'normalized', 'status', 'origin', 'language', 'priority'], ...keywords.map((k): Cell[] => [t(k.text), k.normalizedText, k.status, k.origin, k.language, k.priority])] }] : []),
      {
        name: 'Collection_Log',
        rows: [['started_at', 'provider', 'operation', 'status', 'requests', 'records', 'quota_units', 'latency_ms', 'error_code'], ...runs.map((r): Cell[] => [iso(r.startedAt), r.providerId, r.operation, r.status, r.requestCount, r.recordCount, r.quotaUnits, r.latencyMs, r.errorCode])],
      },
      { name: 'Usage', rows: [['day (UTC)', 'provider', 'unit', 'quantity'], ...usage.map((u): Cell[] => [u.day.toISOString().slice(0, 10), u.providerId, u.unit, u._sum.quantity ?? 0])] },
      ...(e.projectId ? await this.analyticsSheets(e.projectId, new Set(posts.filter((p) => policies.get(p.providerId)?.allowDerivedMetrics).map((p) => p.id))) : []),
      { name: 'Data_Dictionary', rows: [['sheet', 'column', 'meaning', 'source', 'when empty'], ...DICTIONARY], widths: [16, 36, 80, 14, 50] },
    ];
    return { buffer: buildXlsx(sheets), rowCounts, withheld: withheldList, warnings };
  }
}
