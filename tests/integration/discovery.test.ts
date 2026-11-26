/**
 * Phase 3 gate — seed keyword → candidate → approved account → posts (Master Plan §16).
 * REAL services + Postgres + REAL Bluesky adapter against a fake AppView (SYNTHETIC data).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

const P = {
  brand: { did: 'did:plc:brandfixture000000000001', handle: 'livewallpaper.example.com', displayName: 'Live Wallpaper App (SYNTHETIC)', description: 'Live wallpaper studio for phones' },
  jane: { did: 'did:plc:janefixture0000000000001', handle: 'jane.example.com', displayName: 'Jane', description: 'cats and coffee' },
  creator: { did: 'did:plc:creatorfixture00000000001', handle: 'ana.example.com', displayName: 'Ana', description: 'Illustrator' },
};
type Prof = (typeof P)[keyof typeof P];
const post = (who: Prof, rkey: string, text: string) => ({
  uri: `at://${who.did}/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author: { did: who.did, handle: who.handle },
  record: { text, createdAt: new Date(Date.now() - 3600_000).toISOString() },
  indexedAt: new Date().toISOString(),
  likeCount: 3,
});

function routes(over: Record<string, any> = {}) {
  return {
    '/xrpc/app.bsky.actor.searchActors': () => ({ body: { actors: [P.brand, P.jane] } }),
    '/xrpc/app.bsky.feed.searchPosts': () => ({
      body: { posts: [post(P.brand, '3b1', 'New live wallpaper pack'), post(P.brand, '3b2', 'live wallpaper update'), post(P.creator, '3a1', 'my live wallpaper art'), post(P.creator, '3a2', 'another live wallpaper')] },
    }),
    '/xrpc/app.bsky.actor.getProfile': ({ url }: { url: URL }) => {
      const p = Object.values(P).find((x) => x.did === url.searchParams.get('actor') || x.handle === url.searchParams.get('actor'));
      return p ? { body: { ...p, followersCount: 100, followsCount: 1, postsCount: 2 } } : { status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } };
    },
    '/xrpc/app.bsky.feed.getAuthorFeed': ({ url }: { url: URL }) => {
      const p = Object.values(P).find((x) => x.did === url.searchParams.get('actor'))!;
      return { body: { feed: [{ post: post(p, '3f1', 'feed post') }] } };
    },
    ...over,
  };
}

async function setup(over: Record<string, any> = {}, settings: Record<string, unknown> = {}) {
  h = await createHarness(routes(over));
  app = await buildServer({ runtime: h.runtime });
  const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Discovery', platforms: ['bluesky', 'tiktok'], languages: ['en'], settings } }));
  return pr.id as string;
}

async function discover(projectId: string, payload: object = {}) {
  const r = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/discover`, payload });
  expect(r.statusCode).toBe(202);
  await h.dispatcher.drain();
  return json(await app.inject({ method: 'GET', url: `/api/v1/jobs/${json(r).job_id}` }));
}

describe('Phase 3: keyword → candidates → approve → posts', () => {
  it('runs the gate flow with evidence, explicit coverage and no automatic tracking', async () => {
    const projectId = await setup();

    // Keywords: dedup by normalized text; rule expansion suggests (does not activate) variants.
    const add = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keywords`, payload: { keywords: [{ text: 'Live Wallpaper' }, { text: '#live  wallpaper' }] } });
    expect(add.statusCode).toBe(201);
    expect(json(add).created).toHaveLength(1);
    expect(json(add).existing).toHaveLength(1);
    const exp = json(await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keywords/expand` }));
    expect(exp.suggested.map((k: { text: string }) => k.text).sort()).toEqual(['live wallpapers', 'livewallpaper']);
    expect(exp.suggested.every((k: { status: string; origin: string }) => k.status === 'SUGGESTED' && k.origin === 'RULE')).toBe(true);

    const job = await discover(projectId);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result.keywords).toEqual(['Live Wallpaper']); // suggestions are not searched
    const cov = job.result.coverage;
    expect(cov.find((c: any) => c.platform === 'tiktok')).toMatchObject({ status: 'SKIPPED', operation: 'provider', reason: expect.stringMatching(/No collector for tiktok/) });
    expect(cov.find((c: any) => c.operation === 'searchAccounts')).toMatchObject({ status: 'OK', results: 2 });
    expect(cov.find((c: any) => c.operation === 'searchPosts')).toMatchObject({ status: 'OK', results: 4, warnings: [expect.stringMatching(/Unauthenticated searchPosts/)] });
    expect(job.result.candidates).toMatchObject({ new: 3, autoApproved: 0 });
    expect(await h.db.projectAccount.count()).toBe(0); // default: nothing tracked without review
    expect(await h.db.searchResult.count()).toBe(6);

    const queue = json(await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/candidates?status=PENDING` }));
    expect(queue.items.map((c: any) => c.account.username)).toEqual(['livewallpaper.example.com', 'ana.example.com', 'jane.example.com']);
    const [brand, ana, jane] = queue.items;
    expect(brand.score).toBeGreaterThan(ana.score);
    expect(brand).toMatchObject({ classification: 'DIRECT_COMPETITOR', evidence: { scoreVersion: 'rule-v1', confidence: 'low', matchedKeywords: ['live wallpaper'] } });
    expect(brand.evidence.samplePosts[0]).toMatchObject({ url: expect.stringMatching(/^https:\/\/bsky\.app\/profile\//), keyword: 'Live Wallpaper' });
    expect(ana.classification).toBe('CREATOR');
    expect(jane.classification).toBe('IRRELEVANT'); // account search hit only, no textual evidence

    // Approve → tracked + initial sync → posts.
    const ap = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/candidates/approve`, payload: { candidateIds: [brand.id] } });
    expect(ap.statusCode).toBe(200);
    expect(json(ap).approved[0].job).toMatchObject({ name: 'account.sync', status: 'QUEUED' });
    await h.dispatcher.drain();
    const link = await h.db.projectAccount.findFirstOrThrow({ where: { projectId } });
    expect(link).toMatchObject({ approvalStatus: 'APPROVED', trackingStatus: 'TRACKING', relevanceScore: brand.score });
    const posts = json(await app.inject({ method: 'GET', url: `/api/v1/posts?projectId=${projectId}` }));
    expect(posts.items).toHaveLength(1);

    // Reject jane; a re-run keeps human decisions and skips tracked accounts.
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/candidates/reject`, payload: { candidateIds: [jane.id] } });
    const again = await discover(projectId);
    expect(again.result.candidates).toMatchObject({ new: 0, updated: 2, alreadyTracked: 1 });
    expect((await h.db.discoveryCandidate.findUniqueOrThrow({ where: { id: jane.id } })).approvalStatus).toBe('REJECTED');
    expect(await h.db.auditLog.count({ where: { action: { startsWith: 'candidate.' } } })).toBe(2);
  });

  it('reports a failed search as ERROR in coverage (never as 0 results) and finishes PARTIAL_SUCCESS', async () => {
    const projectId = await setup({ '/xrpc/app.bsky.feed.searchPosts': () => ({ status: 403, body: { error: 'Forbidden', message: 'Request forbidden by administrative rules' } }) });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keywords`, payload: { keywords: [{ text: 'live wallpaper' }] } });
    const job = await discover(projectId);
    expect(job.status).toBe('PARTIAL_SUCCESS');
    expect(job.result.coverage.find((c: any) => c.operation === 'searchPosts')).toMatchObject({ status: 'ERROR', results: null, reason: expect.stringMatching(/^PERMISSION_DENIED/) });
    expect(job.result.candidates.new).toBe(2);
  });

  it('auto-track is opt-in and bounded by score and per-run count', async () => {
    const projectId = await setup({}, { auto_track: true, auto_track_min_score: 30, auto_track_max_per_run: 1 });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keywords`, payload: { keywords: [{ text: 'live wallpaper' }] } });
    const job = await discover(projectId);
    expect(job.result.candidates.autoApproved).toBe(1);
    await h.dispatcher.drain();
    const links = await h.db.projectAccount.findMany({ include: { account: true } });
    expect(links.map((l) => l.account.username)).toEqual(['livewallpaper.example.com']);
    expect((await h.db.discoveryCandidate.findFirstOrThrow({ where: { approvalStatus: 'APPROVED' } })).decidedBy).toBe('auto');
  });

  it('refuses discovery without ACTIVE keywords and approvals beyond max_accounts', async () => {
    const projectId = await setup({}, { max_accounts: 1 });
    const none = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/discover`, payload: {} });
    expect(none.statusCode).toBe(400);
    expect(json(none).error.code).toBe('INVALID_INPUT');
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/keywords`, payload: { keywords: [{ text: 'live wallpaper' }] } });
    await discover(projectId);
    const ids = json(await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/candidates` })).items.map((c: any) => c.id);
    const tooMany = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/candidates/approve`, payload: { candidateIds: ids.slice(0, 2), sync: false } });
    expect(tooMany.statusCode).toBe(409);
  });
});
