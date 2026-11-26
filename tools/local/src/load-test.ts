#!/usr/bin/env node
/**
 * Load report (Phase 8 gate). SYNTHETIC data only — clearly labelled, in a throwaway database:
 * 200 accounts × 250 posts = 50,000 posts with metric snapshots, one project tracking 100 accounts.
 * Measures the real API over HTTP with concurrent clients, deep keyset pagination, the dashboard, a 50k-row
 * Excel export, and checks the query plan uses indexes.
 *
 *   npm run load:test [-- <posts per account>]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, findRepoRoot } from '@sss/config';
import { createDb, freePort, migrateDeploy, startEmbeddedPostgres } from '@sss/database';
import { InlineDispatcher } from '@sss/queue';
import { createRuntime, seedFromCapabilityRecords } from '@sss/services';
import { buildServer } from '../../../apps/api/src/server.ts';

const ACCOUNTS = 200;
const PER_ACCOUNT = Number(process.argv[2] ?? 250);
const root = findRepoRoot();
const started = new Date();
const dataDir = mkdtempSync(join(tmpdir(), 'sss-load-pg-'));
const pg = await startEmbeddedPostgres({ dataDir, password: 'load-ephemeral', persistent: false });
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10 : null;
};
try {
  await migrateDeploy(pg.url);
  const config = configSchema.parse({ ...process.env, NODE_ENV: 'development', DATABASE_URL: pg.url, QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent', EXPORT_DIR: join(dataDir, 'exports'), EXPORT_MAX_POSTS: '100000' });
  const db = createDb(pg.url, { max: 20 });
  await seedFromCapabilityRecords(db);
  const t0 = performance.now();
  // SYNTHETIC seed (set-based SQL for speed). schema_version marks every row as synthetic load data.
  await db.$executeRawUnsafe(`
    INSERT INTO social_accounts (id, platform, external_id, username, display_name, profile_url, status, provider_id, policy_id, schema_version, last_collected_at, updated_at)
    SELECT gen_random_uuid(), 'bluesky', 'did:plc:synthetic' || g, 'synthetic' || g || '.example.com', 'SYNTHETIC account ' || g, 'https://bsky.app/profile/synthetic' || g || '.example.com',
           'ACTIVE', 'bluesky-appview', 'bluesky-public-v0-unverified', 'synthetic-load', now(), now()
    FROM generate_series(1, ${ACCOUNTS}) g`);
  await db.$executeRawUnsafe(`
    INSERT INTO posts (id, platform, external_id, account_id, url, content_type, caption, hashtags, language, published_at, sort_at, first_seen_at, last_collected_at, last_metrics_at, status, provider_id, policy_id, schema_version, updated_at)
    SELECT gen_random_uuid(), 'bluesky', a.external_id || '/post/' || p, a.id, 'https://bsky.app/profile/' || a.username || '/post/' || p,
           (ARRAY['text','image','video','link'])[1 + (p % 4)], 'SYNTHETIC load-test post ' || p || ' live wallpaper #tag' || (p % 50),
           ARRAY['tag' || (p % 50), 'synthetic'], 'en', now() - (p || ' hours')::interval, now() - (p || ' hours')::interval, now(), now(), now(),
           'AVAILABLE', 'bluesky-appview', 'bluesky-public-v0-unverified', 'synthetic-load', now()
    FROM social_accounts a, generate_series(1, ${PER_ACCOUNT}) p WHERE a.schema_version = 'synthetic-load'`);
  await db.$executeRawUnsafe(`
    INSERT INTO post_metrics (post_id, collected_at, views, likes, comments, shares, saves, extra, missing, provider_id, policy_id)
    SELECT id, now(), NULL, (abs(hashtext(id::text)) % 5000), (abs(hashtext(id::text)) % 50), (abs(hashtext(id::text)) % 20), NULL, '{}', '{"views":"NOT_SUPPORTED"}', provider_id, policy_id FROM posts`);
  const project = await db.project.create({ data: { name: 'SYNTHETIC load project', platforms: ['bluesky'] } });
  await db.$executeRawUnsafe(`INSERT INTO project_accounts (project_id, account_id, approval_status, tracking_status) SELECT '${project.id}'::uuid, id, 'APPROVED', 'TRACKING' FROM social_accounts ORDER BY external_id LIMIT ${ACCOUNTS / 2}`);
  await db.$executeRawUnsafe('ANALYZE');
  const seedMs = Math.round(performance.now() - t0);
  const totalPosts = await db.post.count();

  const dispatcher = new InlineDispatcher();
  const app = await buildServer({ runtime: createRuntime(config, { db, dispatcher }) });
  const port = await freePort();
  await app.listen({ host: '127.0.0.1', port });
  const base = `http://127.0.0.1:${port}/api/v1`;

  async function scenario(name: string, paths: () => string, requests: number, concurrency: number) {
    const lat: number[] = [];
    let errors = 0;
    let next = 0;
    const startedAt = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < requests) {
          next += 1;
          const s = performance.now();
          const r = await fetch(`${base}${paths()}`);
          await r.arrayBuffer();
          lat.push(performance.now() - s);
          if (!r.ok) errors += 1;
        }
      }),
    );
    const secs = (performance.now() - startedAt) / 1000;
    return { name, requests, concurrency, errors, rps: Math.round(requests / secs), p50ms: pct(lat, 50), p95ms: pct(lat, 95), p99ms: pct(lat, 99), maxms: pct(lat, 100) };
  }
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const results = [];
  results.push(await scenario('GET /posts?limit=50 (newest)', () => '/posts?limit=50', 400, 20));
  results.push(await scenario('GET /posts project + hashtag filter', () => `/posts?projectId=${project.id}&hashtag=tag${rnd(50)}&limit=50`, 400, 20));
  results.push(await scenario('GET /posts text search (ILIKE)', () => `/posts?q=post%20${rnd(250)}%20live&limit=25`, 200, 10));
  results.push(await scenario('GET /posts date window', () => `/posts?since=${new Date(Date.now() - (rnd(200) + 10) * 3600_000).toISOString()}&until=${new Date(Date.now() - rnd(10) * 3600_000).toISOString()}&limit=50`, 300, 20));
  results.push(await scenario('GET /dashboard?projectId', () => `/dashboard?projectId=${project.id}`, 100, 10));
  results.push(await scenario('GET /accounts?limit=100', () => '/accounts?limit=100', 200, 10));
  results.push(await scenario('GET /jobs/stats', () => '/jobs/stats', 200, 10));
  results.push(await scenario('GET /metrics', () => '/metrics', 100, 5));

  // Deep keyset pagination: follow the cursor 100 pages (5,000 posts) — latency must stay flat.
  const pageLat: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const s = performance.now();
    const r = (await (await fetch(`${base}/posts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json()) as { nextCursor: string | null };
    pageLat.push(performance.now() - s);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  const deep = { pages: pageLat.length, firstPageMs: Math.round(pageLat[0]!), last10AvgMs: Math.round(pageLat.slice(-10).reduce((a, b) => a + b, 0) / 10), p95ms: pct(pageLat, 95) };

  const plan = await db.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT id FROM posts WHERE status = 'AVAILABLE' ORDER BY sort_at DESC, id DESC LIMIT 51`);
  const planText = plan.map((p) => p['QUERY PLAN']).join('\n');

  // 50k-row Excel export (TEST CONTROL: export allowed in this throwaway DB).
  await db.dataPolicy.updateMany({ where: { providerId: 'bluesky-appview' }, data: { allowedOperations: { allowHistoricalSnapshots: false, allowDerivedMetrics: false, allowMediaProcessing: false, allowExport: true } } });
  const es = performance.now();
  const ex = (await (await fetch(`${base}/exports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'xlsx' }) })).json()) as { export: { id: string } };
  await dispatcher.drain();
  const exRow = (await (await fetch(`${base}/exports/${ex.export.id}`)).json()) as { status: string; rowCounts: Record<string, number>; sizeBytes: number; error: string | null };
  const exportRes = { status: exRow.status, error: exRow.error, rows: exRow.rowCounts.posts, seconds: Math.round((performance.now() - es) / 100) / 10, sizeMB: Math.round((exRow.sizeBytes / 1048576) * 10) / 10, rssMB: Math.round(process.memoryUsage().rss / 1048576) };

  const report = {
    schema: 'sss.load-report/v1',
    kind: 'SYNTHETIC load data (schema_version=synthetic-load) in a throwaway database — not collected data',
    at: started.toISOString(),
    environment: { node: process.version, platform: process.platform, cpus: (await import('node:os')).cpus().length, db: 'embedded PostgreSQL (same machine)', queue: 'inline' },
    dataset: { accounts: ACCOUNTS, posts: totalPosts, metricSnapshots: totalPosts, trackedAccounts: ACCOUNTS / 2, seedMs },
    scenarios: results,
    deepPagination: deep,
    postsQueryUsesIndex: /Index Scan/.test(planText),
    queryPlan: planText,
    export50k: exportRes,
  };
  mkdirSync(join(root, 'docs', 'phase8'), { recursive: true });
  const out = join(root, 'docs', 'phase8', `load-${started.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.table(results);
  console.log('deep pagination', deep, '\nindex used:', report.postsQueryUsesIndex, '\nexport', exportRes, '\nreport:', out);
  await app.close();
  await db.$disconnect();
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
