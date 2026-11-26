import type { Prisma } from '@sss/database';
import { getEffectivePolicy, type EffectivePolicy } from '@sss/policy-engine';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { ExportService } from './exports.ts';
import { NotificationService, type Channel } from './notify.ts';
import { iso, num } from './serialize.ts';

const DAY = 86400_000;

export interface ReportSummary {
  project: { id: string; name: string };
  kind: 'daily' | 'weekly';
  period: { start: string; end: string; timezone: string };
  status: 'SUCCEEDED' | 'PARTIAL_SUCCESS';
  newAccounts: { username: string | null; platform: string; profileUrl: string | null }[];
  posts: { collected: number; byAccount: { username: string | null; posts: number }[] };
  topPosts: { basis: string; items: { url: string | null; account: string | null; likes: number | null; score: number | null; label: string | null }[] };
  trends: { computedAt: string | null; items: { topic: string; signal: string; postsNow: number; confidence: string }[]; note: string | null };
  failures: { providerId: string; errorCode: string | null; runs: number }[];
  unhealthyProviders: string[];
  usage: { providerId: string; unit: string; quantity: number }[];
  costUsd: number;
  pendingCandidates: number;
  actions: string[];
  links: { app: string; explorer: string; insights: string; report: string | null; export: string | null };
  withheldFromNotifications: string | null;
}

/**
 * WF11 daily / WF12 weekly reports (Master Plan §7.8): new competitors, new posts, standout content, trends,
 * failed sources, cost, suggested actions, evidence links. If a source failed in the period the report is
 * PARTIAL_SUCCESS and says which — it never claims "no new content". An Excel export of the period is attached.
 * Notifications carry the summary and links only; third-party post URLs are included only where the provider
 * policy allows export.
 */
export class ReportService {
  constructor(private readonly ctx: ServiceContext) {}

  private appUrl() {
    return (this.ctx.config.PUBLIC_APP_URL ?? `http://127.0.0.1:${this.ctx.config.APP_PORT}`).replace(/\/$/, '');
  }

  async generate(o: { projectId: string; kind: 'daily' | 'weekly'; notify: boolean; jobId: string | null }) {
    const { db, config } = this.ctx;
    const project = await db.project.findUnique({ where: { id: o.projectId } });
    if (!project) throw new AppError('NOT_FOUND', `Project ${o.projectId} not found`);
    const end = nowOf(this.ctx);
    const start = new Date(end.getTime() - (o.kind === 'daily' ? 1 : 7) * DAY);
    const links = await db.projectAccount.findMany({ where: { projectId: project.id }, include: { account: true } });
    const accountIds = links.map((l) => l.accountId);
    const policies = new Map<string, EffectivePolicy>();
    for (const pid of new Set(links.map((l) => l.account.providerId))) policies.set(pid, await getEffectivePolicy(db, pid));
    const exportable = (providerId: string) => policies.get(providerId)?.allowExport === true;

    const newAccounts = links
      .filter((l) => l.approvalStatus === 'APPROVED' && l.createdAt >= start)
      .map((l) => ({ username: l.account.username, platform: l.account.platform, profileUrl: exportable(l.account.providerId) ? l.account.profileUrl : null }));
    const collected = await db.post.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, firstSeenAt: { gte: start, lt: end } }, _count: { _all: true } });
    const byAccount = collected
      .map((c) => ({ username: links.find((l) => l.accountId === c.accountId)?.account.username ?? null, posts: c._count._all }))
      .sort((a, b) => b.posts - a.posts)
      .slice(0, 10);

    // Standout content: viral scores when derived analytics are allowed, else raw likes (labelled as such).
    const viral = await db.viralScore.findMany({ where: { projectId: project.id, status: 'SCORED', scoredAt: { gte: start } }, orderBy: { score: 'desc' }, take: 5 });
    let topPosts: ReportSummary['topPosts'];
    if (viral.length) {
      const posts = await db.post.findMany({ where: { id: { in: viral.map((v) => v.postId) } }, include: { account: true, metrics: { orderBy: { collectedAt: 'desc' }, take: 1 } } });
      topPosts = {
        basis: 'viral-v1 score (experimental)',
        items: viral.map((v) => {
          const p = posts.find((x) => x.id === v.postId);
          return { url: p && exportable(p.providerId) ? p.url : null, account: p?.account.username ?? null, likes: num(p?.metrics[0]?.likes ?? null), score: v.score, label: v.label };
        }),
      };
    } else {
      const ids = await db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM posts p
        JOIN LATERAL (SELECT likes FROM post_metrics m WHERE m.post_id = p.id ORDER BY m.collected_at DESC LIMIT 1) lm ON true
        WHERE p.account_id = ANY(${accountIds}::uuid[]) AND p.first_seen_at >= ${start} AND p.status = 'AVAILABLE' AND lm.likes IS NOT NULL
        ORDER BY lm.likes DESC LIMIT 5`;
      const posts = await db.post.findMany({ where: { id: { in: ids.map((i) => i.id) } }, include: { account: true, metrics: { orderBy: { collectedAt: 'desc' }, take: 1 } } });
      topPosts = {
        basis: 'raw public likes reported by the provider (not a viral score)',
        items: ids.map((i) => {
          const p = posts.find((x) => x.id === i.id)!;
          return { url: exportable(p.providerId) ? p.url : null, account: p.account.username, likes: num(p.metrics[0]?.likes ?? null), score: null, label: null };
        }),
      };
    }

    const snap = await db.trendSnapshot.findFirst({ where: { projectId: project.id }, orderBy: { computedAt: 'desc' } });
    const trendItems = ((snap?.topics ?? []) as { topic: string; signal: string; postsNow: number; confidence: string }[]).filter((t) => t.signal === 'rising' || t.signal === 'new').slice(0, 5);
    const trends = {
      computedAt: iso(snap?.computedAt ?? null),
      items: trendItems.map((t) => ({ topic: t.topic, signal: t.signal, postsNow: t.postsNow, confidence: t.confidence })),
      note: snap ? 'Within the collected sample only.' : 'No trend snapshot yet (derived analytics may be blocked by policy).',
    };

    const runs = await db.collectionRun.findMany({
      where: { startedAt: { gte: start, lt: end }, status: { in: ['FAILED', 'PARTIAL_SUCCESS'] }, OR: [{ accountId: { in: accountIds } }, { job: { projectId: project.id } }] },
      select: { providerId: true, errorCode: true },
    });
    const failMap = new Map<string, { providerId: string; errorCode: string | null; runs: number }>();
    for (const r of runs) {
      const k = `${r.providerId}|${r.errorCode}`;
      failMap.set(k, { providerId: r.providerId, errorCode: r.errorCode, runs: (failMap.get(k)?.runs ?? 0) + 1 });
    }
    const failures = [...failMap.values()];
    const providers = await db.provider.findMany({ where: { enabled: true } });
    const unhealthyProviders = providers.filter((p) => (p.lastHealth as { healthy?: boolean } | null)?.healthy === false).map((p) => p.id);
    const day0 = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const usageRows = await db.usageLog.groupBy({ by: ['providerId', 'unit'], where: { projectId: project.id, day: { gte: day0 } }, _sum: { quantity: true, actualCost: true } });
    const usage = usageRows.map((u) => ({ providerId: u.providerId, unit: u.unit, quantity: u._sum.quantity ?? 0 }));
    const costUsd = Math.round(usageRows.reduce((a, u) => a + Number(u._sum.actualCost ?? 0), 0) * 1e4) / 1e4;
    const pendingCandidates = await db.discoveryCandidate.count({ where: { projectId: project.id, approvalStatus: 'PENDING' } });
    const blockedDerived = [...policies.values()].filter((p) => !p.allowDerivedMetrics).map((p) => p.providerId);

    const actions: string[] = [];
    if (pendingCandidates) actions.push(`Review ${pendingCandidates} discovery candidate(s).`);
    for (const f of failures) actions.push(`${f.providerId}: ${f.runs} failed/partial run(s) (${f.errorCode ?? 'unknown'}) — check the Job Monitor and retry.`);
    for (const p of unhealthyProviders) actions.push(`Provider ${p} is unhealthy — test it on the Data Sources page.`);
    if (blockedDerived.length) actions.push(`Viral/trend/AI analytics are blocked by policy for ${blockedDerived.join(', ')} — pending Product Owner approval.`);
    if (!links.length) actions.push('No accounts are tracked yet — add keywords and run discovery.');

    const status: ReportSummary['status'] = failures.length || unhealthyProviders.length ? 'PARTIAL_SUCCESS' : 'SUCCEEDED';
    const exp = await new ExportService(this.ctx).generateNow({ format: 'xlsx', projectId: project.id, filters: { since: start.toISOString() } });
    const app = this.appUrl();
    const summary: ReportSummary = {
      project: { id: project.id, name: project.name },
      kind: o.kind,
      period: { start: start.toISOString(), end: end.toISOString(), timezone: config.APP_TIMEZONE },
      status,
      newAccounts,
      posts: { collected: collected.reduce((a, c) => a + c._count._all, 0), byAccount },
      topPosts,
      trends,
      failures,
      unhealthyProviders,
      usage,
      costUsd,
      pendingCandidates,
      actions,
      links: { app, explorer: `${app}/#/explore?projectId=${project.id}`, insights: `${app}/#/insights?projectId=${project.id}`, report: null, export: exp.downloadUrl ? `${app}${exp.downloadUrl}` : null },
      withheldFromNotifications: [...policies.values()].some((p) => !p.allowExport) ? 'Post and profile URLs of sources whose policy does not allow export are not included.' : null,
    };
    const row = await db.report.create({
      data: { projectId: project.id, kind: o.kind, periodStart: start, periodEnd: end, status, summary: summary as unknown as Prisma.InputJsonValue, markdown: '', exportId: exp.id, jobId: o.jobId },
    });
    summary.links.report = `${app}/#/reports?id=${row.id}`;
    const markdown = renderMarkdown(summary);
    await db.report.update({ where: { id: row.id }, data: { summary: summary as unknown as Prisma.InputJsonValue, markdown } });

    let delivery: { channel: Channel; status: string; error?: string }[] = [];
    if (o.notify) {
      delivery = await new NotificationService(this.ctx).send({
        projectId: project.id,
        type: 'report',
        dedupKey: `report:${o.kind}:${project.id}:${start.toISOString().slice(0, 10)}`,
        title: `${o.kind === 'daily' ? 'Daily' : 'Weekly'} report — ${project.name}${status === 'PARTIAL_SUCCESS' ? ' (partial: some sources failed)' : ''}`,
        body: renderText(summary),
        data: summary as unknown as Record<string, unknown>,
      });
    }
    return { id: row.id, status, delivery, exportId: exp.id };
  }

  async list(projectId?: string, limit = 30) {
    const rows = await this.ctx.db.report.findMany({ where: projectId ? { projectId } : {}, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, kind: r.kind, status: r.status, periodStart: r.periodStart.toISOString(), periodEnd: r.periodEnd.toISOString(), exportId: r.exportId, createdAt: r.createdAt.toISOString() }));
  }

  async get(id: string) {
    const r = await this.ctx.db.report.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', `Report ${id} not found`);
    return { id: r.id, projectId: r.projectId, kind: r.kind, status: r.status, periodStart: r.periodStart.toISOString(), periodEnd: r.periodEnd.toISOString(), summary: r.summary, markdown: r.markdown, exportDownloadUrl: r.exportId ? `/api/v1/exports/${r.exportId}/download` : null, createdAt: r.createdAt.toISOString() };
  }
}

function lines(s: ReportSummary): string[] {
  const out: string[] = [];
  out.push(`Period: ${s.period.start.slice(0, 16)} → ${s.period.end.slice(0, 16)} UTC (${s.period.timezone})`);
  if (s.status === 'PARTIAL_SUCCESS') out.push('⚠ PARTIAL: some sources failed in this period — missing data is not "no new content".');
  out.push(`New posts collected: ${s.posts.collected}${s.posts.byAccount.length ? ` (${s.posts.byAccount.slice(0, 5).map((a) => `@${a.username}: ${a.posts}`).join(', ')})` : ''}`);
  out.push(`New tracked accounts: ${s.newAccounts.length}${s.newAccounts.length ? ` (${s.newAccounts.map((a) => `@${a.username}`).join(', ')})` : ''}`);
  if (s.topPosts.items.length) {
    out.push(`Standout posts (${s.topPosts.basis}):`);
    for (const p of s.topPosts.items) out.push(`  • @${p.account ?? '?'} — ${p.score !== null ? `score ${p.score}${p.label ? ` ${p.label}` : ''}` : `${p.likes ?? '—'} likes`}${p.url ? ` ${p.url}` : ''}`);
  }
  if (s.trends.items.length) out.push(`Topics (${s.trends.note}): ${s.trends.items.map((t) => `${t.topic} ${t.signal} (${t.postsNow}, ${t.confidence})`).join('; ')}`);
  if (s.failures.length) out.push(`Failed sources: ${s.failures.map((f) => `${f.providerId} ${f.errorCode ?? '?'} ×${f.runs}`).join('; ')}`);
  out.push(`Cost: $${s.costUsd.toFixed(2)} · usage ${s.usage.map((u) => `${u.providerId} ${u.unit} ${u.quantity}`).join(', ') || '—'}`);
  if (s.actions.length) {
    out.push('Suggested actions:');
    for (const a of s.actions) out.push(`  • ${a}`);
  }
  if (s.withheldFromNotifications) out.push(s.withheldFromNotifications);
  return out;
}

export function renderText(s: ReportSummary): string {
  return [...lines(s), '', `Report: ${s.links.report ?? s.links.app}`, ...(s.links.export ? [`Excel: ${s.links.export}`] : []), `Explorer: ${s.links.explorer}`].join('\n');
}

export function renderMarkdown(s: ReportSummary): string {
  return [`# ${s.kind === 'daily' ? 'Daily' : 'Weekly'} report — ${s.project.name}`, '', ...lines(s).map((l) => (l.startsWith('  •') ? `- ${l.slice(4)}` : `${l}  `)), '', `[Content Explorer](${s.links.explorer}) · [Insights](${s.links.insights})${s.links.export ? ` · [Excel](${s.links.export})` : ''}`].join('\n');
}
