/**
 * Phase 5 — exports (policy guard, formats, formula injection, download) and the dashboard API.
 * REAL services + Postgres + REAL Bluesky adapter against a fake AppView (SYNTHETIC data).
 */
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

function sheetXml(buf: Buffer, n: number): string {
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen, i + 30 + nameLen + comp);
    if (name === `xl/worksheets/sheet${n}.xml`) return inflateRawSync(data).toString('utf8');
    i += 30 + nameLen + comp;
  }
  throw new Error(`sheet ${n} not found`);
}

async function setup() {
  const evil = fixturePost('3e1', new Date(Date.now() - 3600_000).toISOString(), 7);
  (evil.post.record as { text: string }).text = '=HYPERLINK("http://evil.example","click") #livewallpaper';
  h = await createHarness({
    '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
    '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [evil, fixturePost('3e0', new Date(Date.now() - 7200_000).toISOString(), null)] } }),
  });
  app = await buildServer({ runtime: h.runtime });
  const pr = json(await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Hình nền động', platforms: ['bluesky'] } }));
  await app.inject({ method: 'POST', url: `/api/v1/projects/${pr.id}/keywords`, payload: { keywords: [{ text: 'live wallpaper' }] } });
  await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id } });
  await h.dispatcher.drain();
  return pr.id as string;
}

async function exportNow(body: object) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/exports', payload: body });
  expect(r.statusCode).toBe(202);
  await h.dispatcher.drain();
  return json(await app.inject({ method: 'GET', url: `/api/v1/exports/${json(r).export.id}` }));
}

const allowExport = () =>
  h.db.dataPolicy.updateMany({ where: { providerId: 'bluesky-appview' }, data: { allowedOperations: { allowHistoricalSnapshots: false, allowDerivedMetrics: false, allowMediaProcessing: false, allowExport: true } } });

describe('exports (WF17) with the policy guard', () => {
  it('withholds rows whose provider policy denies export and says so (default deny)', async () => {
    const projectId = await setup();
    const e = await exportNow({ format: 'xlsx', projectId });
    expect(e).toMatchObject({ status: 'SUCCEEDED', rowCounts: { posts: 0, accounts: 0, keywords: 1 }, withheld: [{ providerId: 'bluesky-appview', posts: 2, accounts: 1, reason: expect.stringMatching(/allowExport=false/) }] });
    const dl = await app.inject({ method: 'GET', url: e.downloadUrl });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toMatch(/spreadsheetml/);
    expect(dl.headers['content-disposition']).toMatch(/filename\*=UTF-8''sss-hinh-nen-đong|filename\*=UTF-8''sss-/);
    const summary = sheetXml(dl.rawPayload, 1);
    expect(summary).toContain('Withheld: bluesky-appview');
  });

  it('exports rows when the policy allows it: provenance, nulls as empty, formula injection neutralized', async () => {
    const projectId = await setup();
    await allowExport();
    const x = await exportNow({ format: 'xlsx', projectId });
    expect(x).toMatchObject({ status: 'SUCCEEDED', rowCounts: { posts: 2, accounts: 1 }, withheld: [] });
    const buf = (await app.inject({ method: 'GET', url: x.downloadUrl })).rawPayload;
    const posts = sheetXml(buf, 3);
    expect(posts).toContain(`'=HYPERLINK(&quot;http://evil.example&quot;`); // text, prefixed — never a live formula from data
    expect(posts).toContain('bluesky-public-v0-unverified');
    expect(posts).toMatch(/HYPERLINK\(&quot;https:\/\/bsky\.app\/profile\//); // our own link to the original post

    const csv = await exportNow({ format: 'csv', projectId, filters: { q: 'evil.example' } });
    expect(csv.rowCounts).toEqual({ posts: 1 });
    const text = (await app.inject({ method: 'GET', url: csv.downloadUrl })).body;
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example""`);

    const js = await exportNow({ format: 'json', projectId });
    const body = json(await app.inject({ method: 'GET', url: js.downloadUrl }));
    expect(body.meta).toMatchObject({ schema: 'sss.export/v1', timezone: 'Asia/Ho_Chi_Minh', rowCounts: { posts: 2 } });
    const nullPost = body.posts.find((p: any) => p.url.endsWith('/3e0'));
    expect(nullPost).toMatchObject({ likes: null, views: null });
    expect(body.dataDictionary.length).toBeGreaterThan(10);

    const list = json(await app.inject({ method: 'GET', url: '/api/v1/exports' }));
    expect(list.items).toHaveLength(3);
  });

  it('expired exports are not downloadable and WF14 deletes them', async () => {
    const projectId = await setup();
    const e = await exportNow({ format: 'json', projectId });
    await h.db.export.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'GET', url: e.downloadUrl })).statusCode).toBe(404);
    const { CleanupService } = await import('@sss/services');
    const r = await new CleanupService(h.runtime.ctx).run();
    expect(r.exportsPurged).toBe(1);
    expect(await h.db.export.count()).toBe(0);
  });
});

describe('dashboard API', () => {
  it('summarizes counts, coverage, usage and jobs from real rows', async () => {
    const projectId = await setup();
    const d = json(await app.inject({ method: 'GET', url: `/api/v1/dashboard?projectId=${projectId}` }));
    expect(d.counts).toMatchObject({ projects: 1, trackedAccounts: 1, accounts: 1, posts: 2, newPosts24h: 2, activeKeywords: 1, pendingCandidates: 0 });
    expect(d.latestPosts).toHaveLength(2);
    expect(d.topPostsByLikes7d.items.map((p: any) => p.metrics.likes)).toEqual([7]); // the post without counts is not ranked as 0
    expect(d.coverage.find((c: any) => c.providerId === 'bluesky-appview')).toMatchObject({ enabled: true, usageToday: { requests: 3 } });
    expect(d.postsPerDay.reduce((a: number, r: any) => a + r.posts, 0)).toBe(2);
    expect(d.jobs.byStatus.SUCCEEDED).toBe(1);
  });
});
