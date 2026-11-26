import {
  CollectorError,
  toCollectorError,
  type Account,
  type PlatformAdapter,
  type Post,
  type RequestLogEntry,
  type UsageMeter,
} from '@sss/collector-core';
import { completeness } from './completeness.ts';
import { probeMedia, type MediaProbe } from './media.ts';

export interface Targets {
  accounts: string[];
  invalidAccounts: string[];
  missingPost: string;
  keywords: string[];
  searchLanguage?: string;
  searchRegion?: string;
  searchPages: number;
  accountsToSync: number;
  postsPerAccount: number;
}

export type TestStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface TestResult {
  id: string;
  name: string;
  status: TestStatus;
  durationMs: number;
  errorCode?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RunContext {
  meter: UsageMeter;
  requestLog: RequestLogEntry[];
  /** Adapter configured with a deliberately invalid credential (negative test), if applicable. */
  invalidCredentialAdapter?: PlatformAdapter;
  mediaHosts: string[];
}

export interface RunOutcome {
  tests: TestResult[];
  accounts: Account[];
  posts: Post[];
  idsObserved: {
    resolved: Record<string, string | null>;
    postsByAccount: Record<string, string[]>;
    searchPostIds: Record<string, string[]>;
  };
  media: MediaProbe[];
}

/**
 * Runs the Master Plan §4.2 PoC test cases against ONE adapter with REAL provider calls.
 * Every outcome (success or typed error) is recorded; nothing is fabricated or defaulted.
 */
export async function runFeasibility(adapter: PlatformAdapter, t: Targets, ctx: RunContext): Promise<RunOutcome> {
  const tests: TestResult[] = [];
  const accounts: Account[] = [];
  const posts: Post[] = [];
  const ids: RunOutcome['idsObserved'] = { resolved: {}, postsByAccount: {}, searchPostIds: {} };
  let budgetHit: CollectorError | null = null;

  async function tc(
    id: string,
    name: string,
    fn: () => Promise<{ data?: Record<string, unknown>; status?: TestStatus; message?: string } | void>,
    expectError?: CollectorError['code'][],
  ): Promise<void> {
    if (budgetHit) {
      tests.push({ id, name, status: 'SKIP', durationMs: 0, errorCode: 'BUDGET_EXCEEDED', message: 'Skipped: run budget exhausted earlier' });
      return;
    }
    const started = performance.now();
    try {
      const r = (await fn()) ?? {};
      const status: TestStatus = r.status ?? (expectError ? 'FAIL' : 'PASS');
      tests.push({
        id,
        name,
        status,
        durationMs: Math.round(performance.now() - started),
        message: r.message ?? (expectError ? `Expected error ${expectError.join('|')} but call succeeded` : undefined),
        data: r.data,
      });
    } catch (e) {
      const ce = toCollectorError(e);
      if (ce.code === 'BUDGET_EXCEEDED') budgetHit = ce;
      const ok = expectError?.includes(ce.code) ?? false;
      tests.push({
        id,
        name,
        status: ok ? 'PASS' : ce.code === 'BUDGET_EXCEEDED' ? 'SKIP' : 'FAIL',
        durationMs: Math.round(performance.now() - started),
        errorCode: ce.code,
        message: `${ok ? 'Expected error: ' : ''}${ce.message}`.slice(0, 500),
        data: ce.providerReason ? { providerReason: ce.providerReason, httpStatus: ce.httpStatus } : undefined,
      });
    }
  }

  // TC01 — health
  await tc('TC01', 'healthCheck', async () => {
    const h = await adapter.healthCheck();
    return { status: h.healthy ? 'PASS' : 'FAIL', data: { ...h }, message: h.message };
  });

  // TC02 — credentials (valid path + negative path)
  await tc('TC02a', 'validateCredentials (configured)', async () => {
    const c = await adapter.validateCredentials();
    const ok = c.state === 'VALID' || c.state === 'NOT_REQUIRED';
    return { status: ok ? 'PASS' : 'FAIL', data: { state: c.state }, message: c.message };
  });
  if (ctx.invalidCredentialAdapter) {
    const bad = ctx.invalidCredentialAdapter;
    await tc('TC02b', 'validateCredentials (deliberately invalid) is classified, not crashing', async () => {
      const c = await bad.validateCredentials();
      return { status: c.state === 'INVALID' ? 'PASS' : 'FAIL', data: { state: c.state }, message: c.message };
    });
  } else {
    tests.push({ id: 'TC02b', name: 'validateCredentials (deliberately invalid)', status: 'SKIP', durationMs: 0, message: 'No credential configured for this provider; negative test not applicable' });
  }

  // TC03 — resolve 3–5 public URLs/usernames to stable external IDs
  for (const [i, input] of t.accounts.entries()) {
    await tc(`TC03.${i + 1}`, `resolveAccount ${input}`, async () => {
      const a = await adapter.resolveAccount({ input });
      ids.resolved[input] = a.externalId;
      if (!accounts.some((x) => x.externalId === a.externalId)) accounts.push(a);
      return { data: { externalId: a.externalId, username: a.username, followers: a.metrics?.followers ?? null } };
    });
    if (!(input in ids.resolved)) ids.resolved[input] = null;
  }

  // TC04 — nonexistent account must be a typed NOT_FOUND, never an empty success
  for (const [i, input] of t.invalidAccounts.entries()) {
    await tc(`TC04.${i + 1}`, `resolveAccount nonexistent ${input}`, async () => {
      await adapter.resolveAccount({ input });
    }, ['NOT_FOUND', 'PRIVATE_OR_REMOVED']);
  }

  // TC05 — search accounts (3 keywords)
  for (const [i, q] of t.keywords.entries()) {
    await tc(`TC05.${i + 1}`, `searchAccounts "${q}"`, async () => {
      const p = await adapter.searchAccounts({ query: q, limit: 25, language: t.searchLanguage, region: t.searchRegion });
      return { data: { count: p.items.length, hasNextCursor: p.nextCursor !== null, usage: p.usage, warnings: p.warnings, sample: p.items.slice(0, 5).map((a) => a.username ?? a.externalId) } };
    });
  }

  // TC06 — search posts (3 keywords × N pages, language hint)
  for (const [i, q] of t.keywords.entries()) {
    let cursor: string | null = null;
    for (let page = 1; page <= t.searchPages; page++) {
      if (page > 1 && cursor === null) {
        tests.push({ id: `TC06.${i + 1}.p${page}`, name: `searchPosts "${q}" page ${page}`, status: 'SKIP', durationMs: 0, message: 'No next cursor returned' });
        break;
      }
      const cur: string | null = cursor;
      await tc(`TC06.${i + 1}.p${page}`, `searchPosts "${q}" page ${page}`, async () => {
        const p = await adapter.searchPosts({ query: q, limit: 25, cursor: cur, language: t.searchLanguage, region: t.searchRegion });
        cursor = p.nextCursor;
        (ids.searchPostIds[q] ??= []).push(...p.items.map((x) => x.externalId));
        posts.push(...p.items);
        const langs = countBy(p.items.map((x) => x.language ?? 'null'));
        return { data: { count: p.items.length, hasNextCursor: p.nextCursor !== null, languages: langs, usage: p.usage, warnings: p.warnings } };
      });
    }
  }

  // TC07 — profile + 10–20 recent posts per account
  const syncAccounts = accounts.slice(0, t.accountsToSync);
  for (const [i, acc] of syncAccounts.entries()) {
    await tc(`TC07.${i + 1}`, `getProfile + listPosts(${t.postsPerAccount}) ${acc.username ?? acc.externalId}`, async () => {
      const prof = await adapter.getProfile(acc.externalId);
      const collected: Post[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const warnings: string[] = [];
      do {
        const p = await adapter.listPosts({ accountExternalId: acc.externalId, limit: Math.min(t.postsPerAccount, 50), cursor });
        collected.push(...p.items);
        warnings.push(...p.warnings);
        cursor = p.nextCursor;
        pages += 1;
      } while (collected.length < t.postsPerAccount && cursor && pages < 5);
      const own = collected.slice(0, t.postsPerAccount);
      ids.postsByAccount[acc.externalId] = own.map((x) => x.externalId);
      posts.push(...own);
      const foreign = own.filter((x) => x.accountExternalId !== acc.externalId).length;
      return {
        status: foreign ? 'FAIL' : 'PASS',
        message: foreign ? `${foreign} post(s) attributed to another author` : undefined,
        data: { profileFollowers: prof.metrics?.followers ?? null, postsCollected: own.length, pages, warnings: [...new Set(warnings)] },
      };
    });
  }

  // TC08 — post detail + batched metrics
  const firstPost = posts.find((p) => ids.postsByAccount[p.accountExternalId]?.includes(p.externalId)) ?? posts[0];
  await tc('TC08a', 'getPostDetail', async () => {
    if (!firstPost) return { status: 'SKIP', message: 'No post collected' };
    const d = await adapter.getPostDetail(firstPost.externalId);
    return { status: d.externalId === firstPost.externalId ? 'PASS' : 'FAIL', data: { externalId: d.externalId, metrics: d.metrics } };
  });
  const metricIds = [...new Set(Object.values(ids.postsByAccount).flat())].slice(0, 60);
  await tc('TC08b', `getPostMetrics batch (${metricIds.length})`, async () => {
    if (!metricIds.length) return { status: 'SKIP', message: 'No post IDs' };
    const m = await adapter.getPostMetrics(metricIds);
    const missingRates = Object.fromEntries(
      (['views', 'likes', 'comments', 'shares', 'saves'] as const).map((k) => [k, round(m.filter((x) => x[k] === null).length / Math.max(1, m.length))]),
    );
    return { data: { requested: metricIds.length, returned: m.length, nullRateByMetric: missingRates } };
  });

  // TC09 — comments capability (only counts recorded; comment text is NOT persisted by default policy)
  await tc('TC09', 'listComments (counts only, text not persisted)', async () => {
    if (!firstPost) return { status: 'SKIP', message: 'No post collected' };
    const c = await adapter.listComments({ postExternalId: firstPost.externalId, limit: 20 });
    return { data: { count: c.items.length, hasNextCursor: c.nextCursor !== null, warnings: c.warnings } };
  }, undefined);

  // TC10 — removed/nonexistent post is a typed error
  await tc('TC10', 'getPostDetail nonexistent post', async () => {
    await adapter.getPostDetail(t.missingPost);
  }, ['NOT_FOUND', 'PRIVATE_OR_REMOVED']);

  // TC11 — cursor reuse: same cursor twice must return the same page
  const acc0 = syncAccounts[0];
  await tc('TC11', 'cursor reuse (listPosts page 2 fetched twice)', async () => {
    if (!acc0) return { status: 'SKIP', message: 'No account' };
    const p1 = await adapter.listPosts({ accountExternalId: acc0.externalId, limit: 5 });
    if (!p1.nextCursor) return { status: 'SKIP', message: 'No cursor returned' };
    const a = await adapter.listPosts({ accountExternalId: acc0.externalId, limit: 5, cursor: p1.nextCursor });
    const b = await adapter.listPosts({ accountExternalId: acc0.externalId, limit: 5, cursor: p1.nextCursor });
    const same = JSON.stringify(a.items.map((x) => x.externalId)) === JSON.stringify(b.items.map((x) => x.externalId));
    const overlapWithPage1 = a.items.filter((x) => p1.items.some((y) => y.externalId === x.externalId)).length;
    return { status: same ? 'PASS' : 'FAIL', data: { reusable: same, page2Count: a.items.length, overlapWithPage1 } };
  });

  // TC12 — media URL behaviour (HEAD only; nothing downloaded or stored)
  const mediaUrls = [
    ...accounts.slice(0, 2).map((a) => a.avatarUrl),
    ...posts.filter((p) => p.thumbnailUrl).slice(0, 3).map((p) => p.thumbnailUrl),
  ].filter((u): u is string => Boolean(u));
  const media: MediaProbe[] = [];
  await tc('TC12', `media URL expiry check (HEAD ${mediaUrls.length} URLs)`, async () => {
    for (const u of mediaUrls) media.push(await probeMedia(u, ctx.mediaHosts));
    return { data: { probes: media.length, ok: media.filter((m) => m.status === 200).length, signed: media.filter((m) => m.looksSigned).length } };
  });

  // TC13 — completeness (field fill rate) over everything collected
  await tc('TC13', 'field completeness', async () => ({ data: completeness(accounts, posts) }));

  return { tests, accounts, posts, idsObserved: ids, media };
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
