import { join } from 'node:path';
import { z } from 'zod';
import { CollectorError, UsageMeter, type RequestLogEntry } from '@sss/collector-core';
import {
  APPLE_PROVIDER_ID,
  AppleAppStoreClient,
  effectiveStorePolicy,
  extractSocialLinks,
  fetchPublicPage,
  loadStoreRecord,
  parseAppInput,
  siteOf,
  type AppRecord,
  type PageFetchResult,
  type StoreRecord,
} from '@sss/collector-appstore';
import { findRepoRoot } from '@sss/config';
import type { Prisma } from '@sss/database';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';

/**
 * App Spy (Phase 9, P9-03, ADR-0018): Apple App Store listings through the official iTunes Search/Lookup API,
 * and app → developer website → social profile links with evidence. Google Play is BLOCKED (no official API).
 * Every call is capped per UTC day (APPLE_SEARCH_DAILY_REQUESTS) and logged in usage_logs.
 */

export const appSearchSchema = z.object({ term: z.string().trim().min(1).max(100), country: z.string().regex(/^[a-zA-Z]{2}$/).default('us'), limit: z.coerce.number().int().min(1).max(50).default(25) }).strict();
export const appTrackSchema = z.object({ input: z.string().trim().min(1).max(500), country: z.string().regex(/^[a-zA-Z]{2}$/).optional(), projectId: z.uuid().optional() }).strict();
export const appListSchema = z.object({ projectId: z.uuid().optional() }).strict();
export const appLinkDecisionSchema = z.object({ status: z.enum(['CONFIRMED', 'REJECTED', 'PROPOSED']) }).strict();

type ClientFactory = (o: { meter: UsageMeter; onLog: (e: RequestLogEntry) => void }) => AppleAppStoreClient;
type PageFetcher = (url: string) => Promise<PageFetchResult>;

let clientFactory: ClientFactory = (o) => new AppleAppStoreClient(o);
let pageFetcher: PageFetcher = (url) => fetchPublicPage(url);
let recordPath = (): string => join(findRepoRoot(), 'docs', 'feasibility', 'app-stores', 'apple.json');

/** Test hooks: point App Spy at a fake Apple API and fake websites. Returns a restore function. */
export function setAppSpyDepsForTests(o: { client?: ClientFactory; fetchPage?: PageFetcher; recordPath?: string }): () => void {
  const prev = { clientFactory, pageFetcher, recordPath };
  if (o.client) clientFactory = o.client;
  if (o.fetchPage) pageFetcher = o.fetchPage;
  if (o.recordPath) {
    const p = o.recordPath;
    recordPath = () => p;
  }
  return () => {
    ({ clientFactory, pageFetcher, recordPath } = prev);
  };
}

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export class AppSpyService {
  constructor(private readonly ctx: ServiceContext) {}

  private record(): StoreRecord {
    return loadStoreRecord(recordPath());
  }

  policy() {
    const r = this.record();
    return { store: r.store, provider: r.provider, status: r.status, checkedAt: r.checkedAt, ...effectiveStorePolicy(r), proposalStatus: r.policyProposal?.status ?? null, limitations: r.limitations };
  }

  /** Run Apple calls under the daily cap and record usage (also for failed calls: Apple counts them toward the rate). */
  private async withApple<T>(projectId: string | null, fn: (c: AppleAppStoreClient) => Promise<T>): Promise<T> {
    const rec = this.record();
    if (rec.status !== 'VERIFIED') throw new AppError('POLICY_BLOCKED', `Apple App Store source is ${rec.status}`);
    const day = utcDay(nowOf(this.ctx));
    const used = await this.ctx.db.usageLog.aggregate({ where: { providerId: APPLE_PROVIDER_ID, day }, _sum: { quantity: true } });
    const left = this.ctx.config.APPLE_SEARCH_DAILY_REQUESTS - (used._sum.quantity ?? 0);
    if (left <= 0) throw new AppError('BUDGET_EXCEEDED', `Daily Apple Search API cap reached (APPLE_SEARCH_DAILY_REQUESTS=${this.ctx.config.APPLE_SEARCH_DAILY_REQUESTS})`);
    let calls = 0;
    const client = clientFactory({ meter: new UsageMeter({ maxRequests: Math.min(left, 20) }), onLog: () => calls++ });
    try {
      return await fn(client);
    } finally {
      if (calls) await this.ctx.db.usageLog.create({ data: { providerId: APPLE_PROVIDER_ID, projectId, unit: 'requests', quantity: calls, day } });
    }
  }

  async search(input: unknown) {
    const q = appSearchSchema.parse(input);
    const country = q.country.toLowerCase();
    const results = await this.withApple(null, (c) => c.searchApps(q.term, { country, limit: q.limit }));
    const tracked = await this.ctx.db.app.findMany({ where: { store: 'apple', country, storeAppId: { in: results.map((r) => r.storeAppId) } }, select: { id: true, storeAppId: true } });
    const byStore = new Map(tracked.map((t) => [t.storeAppId, t.id]));
    return {
      term: q.term,
      country,
      note: 'Apple search is fuzzy: results are suggestions, not proof that an app matches. Track an app by its link or id.',
      items: results.map((r) => ({ ...publicView(r), trackedId: byStore.get(r.storeAppId) ?? null })),
    };
  }

  async track(input: unknown) {
    const v = appTrackSchema.parse(input);
    if (v.projectId && !(await this.ctx.db.project.findUnique({ where: { id: v.projectId }, select: { id: true } }))) throw new AppError('NOT_FOUND', `Project ${v.projectId} not found`);
    const parsed = parseAppInput(v.input);
    const country = (v.country ?? (parsed.kind === 'id' ? parsed.country : undefined) ?? 'us').toLowerCase();
    const rec = await this.withApple(v.projectId ?? null, (c) => (parsed.kind === 'id' ? c.lookupApps([parsed.id], country).then((r) => r[0] ?? null) : c.lookupBundle(parsed.bundleId, country)));
    if (!rec) throw new AppError('NOT_FOUND', `No App Store app ${parsed.kind === 'id' ? parsed.id : parsed.bundleId} in the ${country.toUpperCase()} storefront`);
    const app = await this.upsert(rec);
    if (v.projectId) await this.ctx.db.projectApp.upsert({ where: { projectId_appId: { projectId: v.projectId, appId: app.id } }, create: { projectId: v.projectId, appId: app.id }, update: {} });
    return this.get(app.id);
  }

  private async upsert(r: AppRecord) {
    const policy = effectiveStorePolicy(this.record());
    if (!policy.storeMetadata) throw new AppError('POLICY_BLOCKED', 'Storing App Store listings is not allowed by the current policy');
    const data = {
      bundleId: r.bundleId,
      name: r.name,
      developerId: r.developerId,
      developerName: r.developerName,
      sellerName: r.sellerName,
      websiteUrl: r.websiteUrl,
      storeUrl: r.storeUrl,
      developerUrl: r.developerUrl,
      genre: r.genre,
      price: r.price,
      currency: r.currency,
      rating: r.rating,
      ratingCount: r.ratingCount,
      version: r.version,
      releasedAt: r.releasedAt ? new Date(r.releasedAt) : null,
      storeUpdatedAt: r.storeUpdatedAt ? new Date(r.storeUpdatedAt) : null,
      description: r.description,
      details: r.details as unknown as Prisma.InputJsonValue,
      status: 'ACTIVE',
      providerId: APPLE_PROVIDER_ID,
      policyId: policy.policyId,
      collectedAt: nowOf(this.ctx),
    };
    // Latest listing only: the row is overwritten (no history until snapshots are approved).
    return this.ctx.db.app.upsert({ where: { store_storeAppId_country: { store: 'apple', storeAppId: r.storeAppId, country: r.country } }, create: { store: 'apple', storeAppId: r.storeAppId, country: r.country, ...data }, update: data });
  }

  async list(input: unknown) {
    const q = appListSchema.parse(input ?? {});
    const rows = await this.ctx.db.app.findMany({
      where: q.projectId ? { projects: { some: { projectId: q.projectId } } } : {},
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { projects: { select: { projectId: true } }, _count: { select: { links: true } } },
    });
    return rows.map((a) => ({ ...view(a), projectIds: a.projects.map((p) => p.projectId), linkCount: a._count.links }));
  }

  async get(id: string) {
    const a = await this.ctx.db.app.findUnique({
      where: { id },
      include: { projects: { select: { projectId: true } }, links: { orderBy: [{ status: 'asc' }, { platform: 'asc' }], include: { account: { select: { id: true, platform: true, username: true, displayName: true, profileUrl: true } } } } },
    });
    if (!a) throw new AppError('NOT_FOUND', `App ${id} not found`);
    return {
      ...view(a),
      projectIds: a.projects.map((p) => p.projectId),
      links: a.links.map((l) => ({ id: l.id, platform: l.platform, handle: l.handle, profileUrl: l.profileUrl, method: l.method, confidence: l.confidence, status: l.status, evidence: l.evidence, account: l.account, decidedAt: l.decidedAt?.toISOString() ?? null, createdAt: l.createdAt.toISOString() })),
      policy: this.policy(),
    };
  }

  async refresh(id: string) {
    const a = await this.ctx.db.app.findUnique({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', `App ${id} not found`);
    const rec = await this.withApple(null, (c) => c.lookupApps([a.storeAppId], a.country).then((r) => r[0] ?? null));
    if (!rec) {
      await this.ctx.db.app.update({ where: { id }, data: { status: 'NOT_FOUND', collectedAt: nowOf(this.ctx) } });
    } else await this.upsert(rec);
    return this.get(id);
  }

  /** The developer's other apps (live; nothing is stored). */
  async developerApps(id: string) {
    const a = await this.ctx.db.app.findUnique({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', `App ${id} not found`);
    if (!a.developerId) throw new AppError('INVALID_INPUT', 'The listing has no developer id');
    const r = await this.withApple(null, (c) => c.developerApps(a.developerId!, { country: a.country }));
    const tracked = await this.ctx.db.app.findMany({ where: { store: 'apple', country: a.country, storeAppId: { in: r.apps.map((x) => x.storeAppId) } }, select: { id: true, storeAppId: true } });
    const byStore = new Map(tracked.map((t) => [t.storeAppId, t.id]));
    return { developer: r.developer, items: r.apps.map((x) => ({ ...publicView(x), trackedId: byStore.get(x.storeAppId) ?? null })) };
  }

  /**
   * Evidence chain: store listing → developer website listed by the store → profile links published on that page.
   * Never by name. Re-running keeps decisions already made (CONFIRMED/REJECTED) and refreshes the evidence.
   */
  async discoverLinks(id: string) {
    const a = await this.ctx.db.app.findUnique({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', `App ${id} not found`);
    if (!effectiveStorePolicy(this.record()).developerWebsiteFetch) throw new AppError('POLICY_BLOCKED', 'Fetching developer websites is not allowed by the current policy');
    if (!a.websiteUrl) throw new AppError('INVALID_INPUT', 'The App Store listing has no developer website, so no social account can be linked with evidence (names are never matched)');
    let page: PageFetchResult;
    try {
      page = await pageFetcher(a.websiteUrl);
    } catch (e) {
      if (e instanceof CollectorError || e instanceof AppError) throw e;
      throw new AppError('PROVIDER_UNAVAILABLE', `Website fetch failed: ${(e as Error).message}`);
    }
    const links = extractSocialLinks(page.html, page.finalUrl);
    const sameSite = siteOf(new URL(page.finalUrl).hostname) === siteOf(new URL(a.websiteUrl).hostname);
    const confidence = sameSite ? 'HIGH' : 'MEDIUM';
    let created = 0;
    let matched = 0;
    for (const l of links) {
      const account = await this.ctx.db.socialAccount.findFirst({
        where: {
          platform: l.platform,
          OR: [{ username: { equals: l.handle, mode: 'insensitive' } }, { externalId: l.handle }, { profileUrl: { equals: l.profileUrl, mode: 'insensitive' } }],
        },
        select: { id: true },
      });
      if (account) matched++;
      const evidence = { websiteUrl: a.websiteUrl, finalUrl: page.finalUrl, redirects: page.redirects, sameSite, href: l.href, fetchedAt: page.fetchedAt, storeUrl: a.storeUrl, source: 'App Store listing sellerUrl' };
      const existing = await this.ctx.db.appSocialLink.findUnique({ where: { appId_platform_handle: { appId: id, platform: l.platform, handle: l.handle } } });
      if (existing) {
        await this.ctx.db.appSocialLink.update({ where: { id: existing.id }, data: { evidence, confidence, profileUrl: l.profileUrl, accountId: account?.id ?? existing.accountId } });
      } else {
        await this.ctx.db.appSocialLink.create({ data: { appId: id, platform: l.platform, handle: l.handle, profileUrl: l.profileUrl, accountId: account?.id ?? null, method: 'DEVELOPER_WEBSITE', confidence, evidence } });
        created++;
      }
    }
    return { websiteUrl: a.websiteUrl, finalUrl: page.finalUrl, sameSite, found: links.length, created, matchedTrackedAccounts: matched, app: await this.get(id) };
  }

  async decideLink(linkId: string, input: unknown) {
    const v = appLinkDecisionSchema.parse(input);
    const l = await this.ctx.db.appSocialLink.findUnique({ where: { id: linkId } });
    if (!l) throw new AppError('NOT_FOUND', `Link ${linkId} not found`);
    await this.ctx.db.appSocialLink.update({ where: { id: linkId }, data: { status: v.status, decidedAt: v.status === 'PROPOSED' ? null : nowOf(this.ctx) } });
    return this.get(l.appId);
  }

  async remove(id: string, projectId?: string) {
    if (projectId) {
      await this.ctx.db.projectApp.deleteMany({ where: { appId: id, projectId } });
      return;
    }
    const r = await this.ctx.db.app.deleteMany({ where: { id } });
    if (!r.count) throw new AppError('NOT_FOUND', `App ${id} not found`);
  }
}

/** Search/developer results: listing fields only (no icons or screenshots, by policy). */
function publicView(r: AppRecord) {
  return {
    storeAppId: r.storeAppId,
    country: r.country,
    bundleId: r.bundleId,
    name: r.name,
    developerId: r.developerId,
    developerName: r.developerName,
    websiteUrl: r.websiteUrl,
    storeUrl: r.storeUrl,
    genre: r.genre,
    price: r.price,
    currency: r.currency,
    rating: r.rating,
    ratingCount: r.ratingCount,
    version: r.version,
    storeUpdatedAt: r.storeUpdatedAt,
    missing: r.details.missing,
  };
}

type AppRow = Awaited<ReturnType<ServiceContext['db']['app']['findUniqueOrThrow']>>;
function view(a: AppRow) {
  return {
    id: a.id,
    store: a.store,
    storeAppId: a.storeAppId,
    country: a.country,
    bundleId: a.bundleId,
    name: a.name,
    developerId: a.developerId,
    developerName: a.developerName,
    sellerName: a.sellerName,
    websiteUrl: a.websiteUrl,
    storeUrl: a.storeUrl,
    developerUrl: a.developerUrl,
    genre: a.genre,
    price: a.price === null ? null : Number(a.price),
    currency: a.currency,
    rating: a.rating,
    ratingCount: a.ratingCount,
    version: a.version,
    releasedAt: a.releasedAt?.toISOString() ?? null,
    storeUpdatedAt: a.storeUpdatedAt?.toISOString() ?? null,
    description: a.description,
    details: a.details,
    status: a.status,
    provenance: { providerId: a.providerId, policyId: a.policyId, collectedAt: a.collectedAt.toISOString() },
  };
}
