import { z } from 'zod';
import { toCollectorError, type Account, type CapabilityState, type Page, type Post } from '@sss/collector-core';
import { providerForPlatform } from '@sss/collector-registry';
import type { CandidateClass, DiscoveryCandidate, JobStatus, Prisma } from '@sss/database';
import { AppError, decodeCursor, encodeCursor, type PageResult } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { JobService, toJobView, type JobView } from './jobs.ts';
import { upsertAccount } from './persist.ts';
import { mergeSettings } from './projects.ts';
import { scoreCandidate, SCORE_VERSION, type CandidateSignals } from './scoring.ts';
import { iso } from './serialize.ts';
import { UsageGuard } from './usage.ts';
import { JOB_NAMES, idempotencyKey } from '@sss/queue';

export interface CoverageEntry {
  platform: string;
  providerId: string | null;
  keyword: string | null;
  operation: 'searchAccounts' | 'searchPosts' | 'provider';
  /** OK = searched (results may legitimately be 0) · ERROR = the call failed (NOT "0 results") · SKIPPED = not run, with reason */
  status: 'OK' | 'ERROR' | 'SKIPPED';
  results: number | null;
  reason: string | null;
  warnings: string[];
}

export interface DiscoveryResult {
  status: Extract<JobStatus, 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'CANCELLED' | 'SKIPPED'>;
  keywords: string[];
  coverage: CoverageEntry[];
  candidates: { new: number; updated: number; alreadyTracked: number; autoApproved: number; notEnriched: number };
  usage: { providerId: string; requests: number; quotaUnits: number }[];
  scoreVersion: string;
  warnings: string[];
  error: { code: string; message: string } | null;
}

export interface DiscoverOptions {
  projectId: string;
  keywordIds: string[] | null;
  platforms: string[] | null;
  jobId: string | null;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
  onProgress?: (pct: number) => Promise<void>;
  onLog?: (level: 'info' | 'warn', stage: string, message: string, data?: unknown) => Promise<void>;
}

const USABLE: CapabilityState[] = ['SUPPORTED', 'PARTIAL'];
/** Profiles enriched per provider per run (1 request each on Bluesky). */
const MAX_ENRICH = 30;

interface Agg {
  externalId: string;
  account: Account | null;
  signals: Omit<CandidateSignals, 'keywords' | 'username' | 'displayName' | 'bio'>;
  samplePosts: { url: string; text: string | null; publishedAt: string | null; likes: number | null; keyword: string }[];
  sources: { keyword: string; kind: 'account' | 'post'; rank: number }[];
}

/**
 * WF02 market discovery (Master Plan §7.3): ACTIVE keywords × platforms with a usable search capability →
 * page 1 of account search and post search (budget checked before every call by the usage meter) →
 * aggregate authors → enrich profiles → rule score with evidence → review queue (PENDING).
 * Auto-track is opt-in (`settings.auto_track`) and bounded by score and count. Failed or impossible searches
 * appear in `coverage` as ERROR/SKIPPED with a reason; they are never reported as "0 results".
 */
export class DiscoveryService {
  private readonly usage: UsageGuard;

  constructor(private readonly ctx: ServiceContext) {
    this.usage = new UsageGuard(ctx);
  }

  async discover(o: DiscoverOptions): Promise<DiscoveryResult> {
    const { db } = this.ctx;
    const project = await db.project.findUnique({ where: { id: o.projectId } });
    if (!project) throw new AppError('NOT_FOUND', `Project ${o.projectId} not found`);
    const settings = mergeSettings(project.settings as object);
    const keywords = await db.keyword.findMany({
      where: { projectId: project.id, status: 'ACTIVE', ...(o.keywordIds ? { id: { in: o.keywordIds } } : {}) },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: settings.max_keywords_per_run,
    });
    const res: DiscoveryResult = {
      status: 'SUCCEEDED',
      keywords: keywords.map((k) => k.text),
      coverage: [],
      candidates: { new: 0, updated: 0, alreadyTracked: 0, autoApproved: 0, notEnriched: 0 },
      usage: [],
      scoreVersion: SCORE_VERSION,
      warnings: [],
      error: null,
    };
    if (!keywords.length) throw new AppError('INVALID_INPUT', 'The project has no ACTIVE keywords to search (add some, or activate suggestions)');
    const platforms = o.platforms?.length ? o.platforms : project.platforms;
    if (!platforms.length) throw new AppError('INVALID_INPUT', 'No platforms selected: set project.platforms or pass platforms');
    const normalized = keywords.map((k) => k.normalizedText);
    const limit = Math.min(settings.max_results_per_search, 100);
    let firstError: unknown = null;
    const totalSteps = platforms.length * keywords.length * 2;
    let step = 0;

    for (const platform of platforms) {
      const descriptor = providerForPlatform(platform as never);
      if (!descriptor) {
        const p = await db.provider.findFirst({ where: { platform } });
        res.coverage.push({ platform, providerId: p?.id ?? null, keyword: null, operation: 'provider', status: 'SKIPPED', results: null, reason: `No collector for ${platform} (status ${p?.status ?? 'UNKNOWN'}); add accounts by URL where possible. See docs/feasibility/${platform}.md`, warnings: [] });
        continue;
      }
      const provider = await db.provider.findUnique({ where: { id: descriptor.providerId } });
      if (!provider?.enabled) {
        res.coverage.push({ platform, providerId: descriptor.providerId, keyword: null, operation: 'provider', status: 'SKIPPED', results: null, reason: `Provider not enabled (status ${provider?.status ?? 'not seeded'})`, warnings: [] });
        continue;
      }
      let meter;
      try {
        // Upper bound for this provider in this run: 2 searches per keyword + enrichment.
        meter = await this.usage.meterFor(descriptor.providerId, keywords.length * 2 + MAX_ENRICH + 5);
      } catch (e) {
        const ce = toCollectorError(e);
        res.coverage.push({ platform, providerId: descriptor.providerId, keyword: null, operation: 'provider', status: 'SKIPPED', results: null, reason: `${ce.code}: ${ce.message}`, warnings: [] });
        continue;
      }
      const adapter = descriptor.create({ config: this.ctx.config, meter });
      const caps = await adapter.getCapabilities();
      const startedAt = nowOf(this.ctx);
      const agg = new Map<string, Agg>();
      const touch = (externalId: string) => {
        let a = agg.get(externalId);
        if (!a) {
          a = { externalId, account: null, signals: { accountHits: [], postHits: [] }, samplePosts: [], sources: [] };
          agg.set(externalId, a);
        }
        return a;
      };
      const searchRows: Prisma.SearchResultCreateManyInput[] = [];
      let budgetStop = false;
      let providerErrors = 0;

      try {
        for (const k of keywords) {
          for (const op of ['searchAccounts', 'searchPosts'] as const) {
            step += 1;
            if (await o.isCancelled?.()) {
              res.status = 'CANCELLED';
              break;
            }
            const entry: CoverageEntry = { platform, providerId: descriptor.providerId, keyword: k.text, operation: op, status: 'OK', results: 0, reason: null, warnings: [] };
            res.coverage.push(entry);
            if (!USABLE.includes(caps[op])) {
              Object.assign(entry, { status: 'SKIPPED', results: null, reason: `Capability ${op} is ${caps[op]}` });
              continue;
            }
            if (budgetStop) {
              Object.assign(entry, { status: 'SKIPPED', results: null, reason: 'BUDGET_EXCEEDED earlier in this run' });
              continue;
            }
            try {
              const input = { query: k.text, limit, language: k.language ?? project.languages[0], region: project.markets[0], signal: o.signal };
              if (op === 'searchAccounts') {
                const page: Page<Account> = await adapter.searchAccounts(input);
                entry.results = page.items.length;
                entry.warnings = page.warnings;
                page.items.forEach((acc, i) => {
                  const a = touch(acc.externalId);
                  a.account ??= acc;
                  a.signals.accountHits.push({ keyword: k.normalizedText, rank: i + 1, of: page.items.length });
                  a.sources.push({ keyword: k.text, kind: 'account', rank: i + 1 });
                  searchRows.push({ projectId: project.id, keywordId: k.id, jobId: o.jobId, providerId: descriptor.providerId, kind: 'account', rank: i + 1, accountExternalId: acc.externalId, url: acc.profileUrl, collectedAt: new Date(page.collectedAt) });
                });
              } else {
                const page: Page<Post> = await adapter.searchPosts(input);
                entry.results = page.items.length;
                entry.warnings = page.warnings;
                page.items.forEach((p, i) => {
                  const a = touch(p.accountExternalId);
                  a.signals.postHits.push({ keyword: k.normalizedText, url: p.url });
                  a.sources.push({ keyword: k.text, kind: 'post', rank: i + 1 });
                  if (a.samplePosts.length < 3) {
                    a.samplePosts.push({ url: p.url, text: p.caption?.slice(0, 200) ?? p.title?.slice(0, 200) ?? null, publishedAt: p.publishedAt, likes: p.metrics?.likes ?? null, keyword: k.text });
                  }
                  searchRows.push({ projectId: project.id, keywordId: k.id, jobId: o.jobId, providerId: descriptor.providerId, kind: 'post', rank: i + 1, accountExternalId: p.accountExternalId, postExternalId: p.externalId, url: p.url, collectedAt: new Date(page.collectedAt) });
                });
              }
            } catch (e) {
              const ce = toCollectorError(e);
              Object.assign(entry, { status: 'ERROR', results: null, reason: `${ce.code}: ${ce.message}` });
              providerErrors += 1;
              firstError ??= e;
              if (ce.code === 'BUDGET_EXCEEDED' || ce.code === 'QUOTA_EXCEEDED') budgetStop = true;
            }
            await o.onProgress?.(Math.round((step / totalSteps) * 70));
          }
          if (res.status === 'CANCELLED') break;
        }

        // Enrich: profiles with real counts for the strongest preliminary candidates (search snippets lack counts).
        const ranked = [...agg.values()].sort((a, b) => b.signals.postHits.length + b.signals.accountHits.length - (a.signals.postHits.length + a.signals.accountHits.length));
        let enriched = 0;
        for (const a of ranked) {
          if (res.status === 'CANCELLED' || budgetStop) break;
          if (a.account?.metrics) continue;
          if (enriched >= MAX_ENRICH) break;
          try {
            a.account = await adapter.getProfile(a.externalId, o.signal);
            enriched += 1;
          } catch (e) {
            const ce = toCollectorError(e);
            if (ce.code === 'BUDGET_EXCEEDED') budgetStop = true;
            else res.warnings.push(`Could not enrich ${a.externalId}: ${ce.code}`);
          }
        }

        // Score + persist.
        if (searchRows.length) await db.searchResult.createMany({ data: searchRows });
        const scored: { a: Agg; s: ReturnType<typeof scoreCandidate> }[] = [];
        for (const a of agg.values()) {
          if (!a.account) {
            res.candidates.notEnriched += 1;
            continue;
          }
          scored.push({ a, s: scoreCandidate({ username: a.account.username, displayName: a.account.displayName, bio: a.account.bio, keywords: normalized, ...a.signals }) });
        }
        scored.sort((x, y) => y.s.score - x.s.score);
        for (const { a, s } of scored) {
          const accountId = await db.$transaction(async (tx) => (await upsertAccount(tx, a.account!, descriptor.providerId)).id);
          const tracked = await db.projectAccount.findUnique({ where: { projectId_accountId: { projectId: project.id, accountId } } });
          if (tracked) {
            res.candidates.alreadyTracked += 1;
            continue;
          }
          const evidence = {
            scoreVersion: s.scoreVersion,
            confidence: s.confidence,
            reasons: s.reasons,
            matchedKeywords: s.matchedKeywords,
            sources: a.sources.slice(0, 20).map((x) => ({ ...x, providerId: descriptor.providerId })),
            samplePosts: a.samplePosts,
            profile: { url: a.account!.profileUrl, followers: a.account!.metrics?.followers ?? null, postsCount: a.account!.metrics?.postsCount ?? null, collectedAt: a.account!.provenance.collectedAt },
            jobId: o.jobId,
          };
          const existing = await db.discoveryCandidate.findUnique({ where: { projectId_accountId: { projectId: project.id, accountId } } });
          const now = nowOf(this.ctx);
          if (existing) {
            // Latest evidence replaces the old one; a previous human decision is never overwritten.
            await db.discoveryCandidate.update({ where: { id: existing.id }, data: { score: s.score, classification: s.classification, evidence, lastSeenAt: now, discoveredByJobId: o.jobId } });
            res.candidates.updated += 1;
          } else {
            await db.discoveryCandidate.create({ data: { projectId: project.id, accountId, score: s.score, classification: s.classification, evidence, discoveredByJobId: o.jobId, firstSeenAt: now, lastSeenAt: now } });
            res.candidates.new += 1;
          }
        }
      } finally {
        const snap = meter.snapshot();
        res.usage.push({ providerId: descriptor.providerId, requests: snap.requests, quotaUnits: snap.quotaUnits });
        const finishedAt = nowOf(this.ctx);
        await db.collectionRun.create({
          data: {
            jobId: o.jobId,
            providerId: descriptor.providerId,
            operation: 'project.discover',
            status: providerErrors ? 'PARTIAL_SUCCESS' : res.status === 'CANCELLED' ? 'CANCELLED' : 'SUCCEEDED',
            requestCount: snap.requests,
            recordCount: snap.records,
            quotaUnits: snap.quotaUnits,
            costUsd: snap.costUsd,
            latencyMs: finishedAt.getTime() - startedAt.getTime(),
            errorCode: providerErrors ? toCollectorError(firstError).code : null,
            warnings: [],
            startedAt,
            finishedAt,
          },
        });
        await this.usage.record(descriptor.providerId, snap, { projectId: project.id, jobId: o.jobId });
      }
      if (res.status === 'CANCELLED') break;
    }

    // Opt-in auto-track: bounded by score, per-run count and the project's account cap.
    if (settings.auto_track && res.status !== 'CANCELLED' && settings.auto_track_max_per_run > 0) {
      const tracked = await db.projectAccount.count({ where: { projectId: project.id } });
      const room = Math.max(0, Math.min(settings.auto_track_max_per_run, settings.max_accounts - tracked));
      const picks = await db.discoveryCandidate.findMany({
        where: { projectId: project.id, approvalStatus: 'PENDING', score: { gte: settings.auto_track_min_score }, discoveredByJobId: o.jobId ?? undefined },
        orderBy: { score: 'desc' },
        take: room,
      });
      if (picks.length) {
        const r = await new CandidateService(this.ctx).decide(project.id, picks.map((p) => p.id), 'APPROVED', 'auto', { sync: true });
        res.candidates.autoApproved = r.approved.length;
        res.warnings.push(`Auto-track: approved ${r.approved.length} candidate(s) with score ≥ ${settings.auto_track_min_score}.`);
      }
    }

    const ran = res.coverage.filter((c) => c.operation !== 'provider' && c.status !== 'SKIPPED');
    const errors = res.coverage.filter((c) => c.status === 'ERROR');
    if (!ran.length && res.status !== 'CANCELLED') {
      res.status = 'SKIPPED';
      res.warnings.push('No selected platform could be searched; see coverage for the reasons.');
      return res;
    }
    if (errors.length) {
      if (errors.length === ran.length) throw firstError; // nothing worked → retry policy applies
      res.status = res.status === 'CANCELLED' ? 'CANCELLED' : 'PARTIAL_SUCCESS';
      res.error = { code: toCollectorError(firstError).code, message: toCollectorError(firstError).message };
    }
    if (res.coverage.some((c) => c.status === 'SKIPPED')) res.warnings.push('Some platforms/operations were skipped; see coverage.');
    res.warnings = [...new Set(res.warnings)];
    return res;
  }
}

/* ---------------- review queue ---------------- */

export const candidateQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
    minScore: z.coerce.number().min(0).max(100).optional(),
    classification: z.enum(['DIRECT_COMPETITOR', 'ADJACENT_COMPETITOR', 'CREATOR', 'PUBLISHER', 'IRRELEVANT', 'UNKNOWN']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export const decideSchema = z.object({ candidateIds: z.array(z.uuid()).min(1).max(200), sync: z.boolean().default(true) }).strict();

type CandidateWithAccount = DiscoveryCandidate & { account: { platform: string; externalId: string; username: string | null; displayName: string | null; profileUrl: string; bio: string | null } };

export function toCandidateView(c: CandidateWithAccount) {
  return {
    id: c.id,
    projectId: c.projectId,
    accountId: c.accountId,
    account: c.account,
    score: c.score,
    classification: c.classification,
    approvalStatus: c.approvalStatus,
    evidence: c.evidence,
    decidedAt: iso(c.decidedAt),
    decidedBy: c.decidedBy,
    firstSeenAt: c.firstSeenAt.toISOString(),
    lastSeenAt: c.lastSeenAt.toISOString(),
  };
}

const ACCOUNT_SELECT = { platform: true, externalId: true, username: true, displayName: true, profileUrl: true, bio: true } as const;

export class CandidateService {
  private readonly jobs: JobService;

  constructor(private readonly ctx: ServiceContext) {
    this.jobs = new JobService(ctx);
  }

  /** Review queue, best first (keyset on score desc, id desc). */
  async list(projectId: string, input: unknown): Promise<PageResult<ReturnType<typeof toCandidateView>>> {
    const v = candidateQuerySchema.parse(input);
    if (!(await this.ctx.db.project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
    const c = decodeCursor(v.cursor, z.object({ s: z.number(), id: z.string() }));
    const where: Prisma.DiscoveryCandidateWhereInput = {
      projectId,
      approvalStatus: v.status,
      classification: v.classification as CandidateClass | undefined,
      ...(v.minScore !== undefined ? { score: { gte: v.minScore } } : {}),
    };
    const keyset: Prisma.DiscoveryCandidateWhereInput | undefined = c ? { OR: [{ score: { lt: c.s } }, { score: c.s, id: { lt: c.id } }] } : undefined;
    const rows = await this.ctx.db.discoveryCandidate.findMany({
      where: keyset ? { AND: [where, keyset] } : where,
      orderBy: [{ score: 'desc' }, { id: 'desc' }],
      take: v.limit + 1,
      include: { account: { select: ACCOUNT_SELECT } },
    });
    const items = rows.slice(0, v.limit).map(toCandidateView);
    const last = rows.length > v.limit ? rows[v.limit - 1] : null;
    return { items, nextCursor: last ? encodeCursor({ s: last.score, id: last.id }) : null };
  }

  /**
   * Approve → project link APPROVED/TRACKING (relevance = score) + initial sync job; reject → REJECTED.
   * Respects `max_accounts`. Re-deciding is allowed (a person can change their mind).
   */
  async decide(projectId: string, candidateIds: string[], decision: 'APPROVED' | 'REJECTED', actor: 'local-user' | 'auto', opts: { sync: boolean }) {
    const project = await this.ctx.db.project.findUnique({ where: { id: projectId } });
    if (!project) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
    const settings = mergeSettings(project.settings as object);
    const rows = await this.ctx.db.discoveryCandidate.findMany({ where: { id: { in: candidateIds }, projectId } });
    const missing = candidateIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw new AppError('NOT_FOUND', `Candidate(s) not found in this project: ${missing.join(', ')}`);
    const approved: { candidateId: string; accountId: string; job: JobView | null }[] = [];
    const rejected: string[] = [];
    const warnings: string[] = [];
    if (decision === 'APPROVED') {
      const tracked = await this.ctx.db.projectAccount.count({ where: { projectId } });
      const newOnes = rows.filter((r) => r.approvalStatus !== 'APPROVED').length;
      if (tracked + newOnes > settings.max_accounts) {
        throw new AppError('CONFLICT', `Approving ${newOnes} account(s) would exceed max_accounts (${tracked}/${settings.max_accounts}). Raise the limit in project settings or approve fewer.`);
      }
    }
    const now = nowOf(this.ctx);
    for (const r of rows) {
      await this.ctx.db.$transaction(async (tx) => {
        await tx.discoveryCandidate.update({ where: { id: r.id }, data: { approvalStatus: decision, decidedAt: now, decidedBy: actor } });
        if (decision === 'APPROVED') {
          await tx.projectAccount.upsert({
            where: { projectId_accountId: { projectId, accountId: r.accountId } },
            create: { projectId, accountId: r.accountId, approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', relevanceScore: r.score },
            update: { approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', relevanceScore: r.score },
          });
        } else {
          // Rejecting a previously approved candidate stops tracking it in this project (data is kept).
          await tx.projectAccount.updateMany({ where: { projectId, accountId: r.accountId }, data: { approvalStatus: 'REJECTED', trackingStatus: 'PAUSED' } });
        }
        await tx.auditLog.create({ data: { actor, action: `candidate.${decision.toLowerCase()}`, targetType: 'discovery_candidate', targetId: r.id, metadata: { projectId, accountId: r.accountId, score: r.score } } });
      });
      if (decision === 'REJECTED') {
        rejected.push(r.id);
        continue;
      }
      let job: JobView | null = null;
      if (opts.sync) {
        try {
          job = toJobView(
            await this.jobs.create({
              name: JOB_NAMES.ACCOUNT_SYNC,
              payload: { accountId: r.accountId, projectId, trigger: 'track' },
              idempotencyKey: idempotencyKey({ op: JOB_NAMES.ACCOUNT_SYNC, resource: r.accountId }),
              projectId,
              resourceType: 'social_account',
              resourceId: r.accountId,
            }),
          );
        } catch (e) {
          if (e instanceof AppError && e.code === 'CONFLICT') warnings.push(`A sync of account ${r.accountId} is already active.`);
          else throw e;
        }
      }
      approved.push({ candidateId: r.id, accountId: r.accountId, job });
    }
    return { approved, rejected, warnings };
  }

  async get(projectId: string, id: string) {
    const c = await this.ctx.db.discoveryCandidate.findFirst({ where: { id, projectId }, include: { account: { select: ACCOUNT_SELECT } } });
    if (!c) throw new AppError('NOT_FOUND', `Candidate ${id} not found`);
    return toCandidateView(c);
  }
}

export const discoverRequestSchema = z
  .object({ keywordIds: z.array(z.uuid()).min(1).max(500).optional(), platforms: z.array(z.string().max(20)).min(1).max(10).optional() })
  .strict();

/** Queue WF02 for a project (202 + job). One active discovery per project. */
export async function enqueueDiscovery(ctx: ServiceContext, projectId: string, input: unknown) {
  const v = discoverRequestSchema.parse(input ?? {});
  const project = await ctx.db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
  const active = await ctx.db.keyword.count({ where: { projectId, status: 'ACTIVE', ...(v.keywordIds ? { id: { in: v.keywordIds } } : {}) } });
  if (!active) throw new AppError('INVALID_INPUT', 'No ACTIVE keywords to search: add keywords or activate suggestions first');
  return new JobService(ctx).create({
    name: JOB_NAMES.DISCOVER,
    payload: { projectId, keywordIds: v.keywordIds ?? null, platforms: v.platforms ?? null, trigger: 'manual' },
    idempotencyKey: idempotencyKey({ op: JOB_NAMES.DISCOVER, resource: projectId, projectId }),
    projectId,
    resourceType: 'project',
    resourceId: projectId,
  });
}
