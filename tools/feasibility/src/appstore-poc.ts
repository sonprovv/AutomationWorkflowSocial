#!/usr/bin/env node
/**
 * Phase 9 (P9-03) App Spy feasibility PoC: REAL calls to the Apple iTunes Search/Lookup API (no credential)
 * and one fetch of a developer website listed by the store.
 *
 *   npm run poc:apps                 # ~12 paced calls (≈ 40 s), writes docs/feasibility/runs/apple-app-store/<ts>.json
 *   npm run poc:apps -- --label b    # label the run
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageMeter, type RequestLogEntry } from '@sss/collector-core';
import { AppleAppStoreClient, extractSocialLinks, fetchPublicPage, type AppRecord } from '@sss/collector-appstore';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : undefined;

interface Check {
  id: string;
  title: string;
  result: 'PASS' | 'FAIL' | 'PARTIAL';
  latencyMs: number;
  details: Record<string, unknown>;
  error?: string;
}

const log: RequestLogEntry[] = [];
const meter = new UsageMeter({ maxRequests: 40 });
const apple = new AppleAppStoreClient({ meter, onLog: (e) => log.push(e) });
const checks: Check[] = [];

async function check(id: string, title: string, fn: () => Promise<{ result?: Check['result']; details: Record<string, unknown> }>) {
  const t = performance.now();
  try {
    const r = await fn();
    checks.push({ id, title, result: r.result ?? 'PASS', latencyMs: Math.round(performance.now() - t), details: r.details });
  } catch (e) {
    checks.push({ id, title, result: 'FAIL', latencyMs: Math.round(performance.now() - t), details: {}, error: `${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}` });
  }
  const last = checks.at(-1)!;
  console.log(`${last.result.padEnd(7)} ${id} ${title}${last.error ? ` — ${last.error}` : ''}`);
}

const pct = (xs: AppRecord[], f: (a: AppRecord) => unknown) => (xs.length ? Math.round((100 * xs.filter((a) => f(a) !== null && f(a) !== undefined).length) / xs.length) : 0);
const coverage = (xs: AppRecord[]) => ({ n: xs.length, websiteUrl: pct(xs, (a) => a.websiteUrl), bundleId: pct(xs, (a) => a.bundleId), developerId: pct(xs, (a) => a.developerId), rating: pct(xs, (a) => a.rating), ratingCount: pct(xs, (a) => a.ratingCount), storeUpdatedAt: pct(xs, (a) => a.storeUpdatedAt) });

let first: AppRecord | undefined;
let pool: AppRecord[] = [];

await check('A1', 'search apps by keyword (us)', async () => {
  const r = await apple.searchApps('note taking', { country: 'us', limit: 25 });
  first = r.find((a) => a.websiteUrl) ?? r[0];
  pool.push(...r);
  return { result: r.length > 0 ? 'PASS' : 'FAIL', details: { results: r.length, sample: r.slice(0, 3).map((a) => ({ id: a.storeAppId, name: a.name, developer: a.developerName })), coverage: coverage(r) } };
});
await check('A2', 'search with Unicode keyword in another storefront (vn)', async () => {
  const r = await apple.searchApps('ngân hàng', { country: 'vn', limit: 25 });
  pool.push(...r);
  return { result: r.length > 0 ? 'PASS' : 'FAIL', details: { results: r.length, sample: r.slice(0, 3).map((a) => ({ id: a.storeAppId, name: a.name })), coverage: coverage(r) } };
});
await check('A3', 'search with no matches returns an empty list (not an error)', async () => {
  const r = await apple.searchApps('zqxjvkwplm qzxv', { country: 'us', limit: 5 });
  return { result: r.length === 0 ? 'PASS' : 'PARTIAL', details: { results: r.length } };
});
await check('A4', 'lookup one app by id', async () => {
  const r = await apple.lookupApps([first!.storeAppId], 'us');
  return { result: r[0]?.storeAppId === first!.storeAppId ? 'PASS' : 'FAIL', details: { id: first!.storeAppId, found: r.length, fields: r[0] ? Object.keys(r[0]).length : 0 } };
});
await check('A5', 'lookup several ids in one call', async () => {
  const ids = [...new Set(pool.map((a) => a.storeAppId))].slice(0, 5);
  const r = await apple.lookupApps(ids, 'us');
  return { result: r.length >= 1 ? 'PASS' : 'FAIL', details: { asked: ids.length, found: r.length, note: 'ids not sold in the storefront are absent, not errors' } };
});
await check('A6', 'lookup by bundle id (works, but undocumented)', async () => {
  const r = first!.bundleId ? await apple.lookupBundle(first!.bundleId, 'us') : null;
  return { result: r?.storeAppId === first!.storeAppId ? 'PARTIAL' : 'FAIL', details: { bundleId: first!.bundleId, found: Boolean(r), note: 'PARTIAL by definition: not in Apple’s documentation' } };
});
await check('A7', 'developer and their other apps', async () => {
  const r = await apple.developerApps(first!.developerId!, { country: 'us' });
  return { result: r.developer && r.apps.length ? 'PASS' : 'FAIL', details: { developer: r.developer, apps: r.apps.length, sample: r.apps.slice(0, 3).map((a) => a.name) } };
});
await check('A8', 'unknown id returns nothing (not an error)', async () => {
  const r = await apple.lookupApps(['99999999999'], 'us');
  return { result: r.length === 0 ? 'PASS' : 'FAIL', details: { found: r.length } };
});
await check('A9', 'same app in another storefront (vn)', async () => {
  const r = await apple.lookupApps([first!.storeAppId], 'vn');
  return { result: 'PASS', details: { availableInVn: r.length > 0, ratingUs: first!.rating, ratingVn: r[0]?.rating ?? null, note: 'ratings and availability are per storefront' } };
});
await check('A10', 'developer website listed by the store → social profile links on that website', async () => {
  const withSite = pool.filter((a) => a.websiteUrl).slice(0, 3);
  const out = [];
  for (const a of withSite) {
    try {
      const page = await fetchPublicPage(a.websiteUrl!, { timeoutMs: 10_000 });
      const links = extractSocialLinks(page.html, page.finalUrl);
      out.push({ app: a.name, website: a.websiteUrl, finalUrl: page.finalUrl, redirects: page.redirects.length, links: links.map((l) => `${l.platform}:${l.handle}`) });
    } catch (e) {
      out.push({ app: a.name, website: a.websiteUrl, error: `${(e as { code?: string }).code}: ${(e as Error).message}` });
    }
  }
  const withLinks = out.filter((o) => 'links' in o && o.links && o.links.length > 0).length;
  return { result: withLinks > 0 ? 'PASS' : out.length ? 'PARTIAL' : 'FAIL', details: { sites: out.length, withLinks, out } };
});

const uniq = [...new Map(pool.map((a) => [`${a.country}:${a.storeAppId}`, a])).values()];
const statuses = log.reduce<Record<string, number>>((m, e) => ((m[String(e.status)] = (m[String(e.status)] ?? 0) + 1), m), {});
const lat = log.map((e) => e.latencyMs).sort((a, b) => a - b);
const run = {
  provider: 'apple-itunes-search',
  label: label ?? null,
  startedAt: log[0]?.ts ?? new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  node: process.version,
  summary: { pass: checks.filter((c) => c.result === 'PASS').length, partial: checks.filter((c) => c.result === 'PARTIAL').length, fail: checks.filter((c) => c.result === 'FAIL').length },
  requests: { total: log.length, byStatus: statuses, latencyMs: { p50: lat[Math.floor(lat.length / 2)] ?? null, max: lat.at(-1) ?? null }, pacedEveryMs: 3100 },
  fieldCoverage: coverage(uniq),
  checks,
  requestLog: log,
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(ROOT, 'docs/feasibility/runs/apple-app-store');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${stamp}${label ? `-${label}` : ''}.json`), JSON.stringify(run, null, 2) + '\n');
writeFileSync(join(ROOT, 'docs/feasibility/samples/apple-app-store.sample.json'), JSON.stringify(uniq.slice(0, 2).map((a) => ({ ...a, description: a.description?.slice(0, 200) ?? null })), null, 2) + '\n');
console.log(`\n${run.summary.pass} PASS / ${run.summary.partial} PARTIAL / ${run.summary.fail} FAIL · ${log.length} requests ${JSON.stringify(statuses)} · coverage ${JSON.stringify(run.fieldCoverage)}`);
