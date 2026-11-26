import { inject } from 'vitest';
import { UsageMeter } from '@sss/collector-core';
import { BlueskyAdapter } from '@sss/collector-bluesky';
import { startFakeServer, type FakeRoute, type FakeServer } from '@sss/collector-core/testing';
import { registerProviderForTests } from '@sss/collector-registry';
import { configSchema, type AppConfig } from '@sss/config';
import { createDb, type Db } from '@sss/database';
import { InlineDispatcher } from '@sss/queue';
import { createRuntime, seedFromCapabilityRecords, type Runtime } from '@sss/services';

const TABLES = [
  'search_results', 'discovery_candidates', 'keywords', 'usage_reservations', 'app_settings', 'exports', 'viral_scores', 'content_analysis', 'trend_snapshots',
  'audit_logs', 'usage_logs', 'schedules', 'sync_cursors', 'collection_runs', 'job_logs', 'jobs',
  'post_metrics', 'posts', 'account_metrics', 'project_accounts', 'competitor_accounts', 'social_accounts',
  'competitors', 'projects', 'data_policies', 'providers',
];

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return configSchema.parse({ NODE_ENV: 'test', DATABASE_URL: inject('databaseUrl'), QUEUE_DRIVER: 'inline', LOG_LEVEL: 'silent', MAX_RETRIES: '2', ...over });
}

/** Clean all tables and re-seed providers/policies from the real Phase 0 capability records. */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seedFromCapabilityRecords(db);
}

export interface Harness {
  db: Db;
  runtime: Runtime;
  dispatcher: InlineDispatcher;
  fake: FakeServer;
  close(): Promise<void>;
}

/**
 * Real services + real Postgres + inline dispatcher + the REAL BlueskyAdapter pointed at a local fake
 * AppView (SYNTHETIC data — never presented as collected data).
 */
export async function createHarness(routes: Record<string, FakeRoute>, configOver: Record<string, string> = {}): Promise<Harness> {
  const fake = await startFakeServer(routes);
  const unregister = registerProviderForTests({
    providerId: 'bluesky-appview',
    platform: 'bluesky',
    credentialRef: null,
    credentialRequired: false,
    usageUnit: 'requests',
    dailyCap: (c) => c.BLUESKY_DAILY_REQUESTS,
    create: ({ meter, onLog }) =>
      new BlueskyAdapter({
        meter,
        onLog,
        baseUrls: { publicAppView: fake.baseUrl, appView: fake.baseUrl, entryway: fake.baseUrl },
        allowedHosts: ['127.0.0.1'],
        sleep: async () => {},
      }),
  });
  const config = testConfig(configOver);
  const db = createDb(config.DATABASE_URL!, { max: 5 });
  await resetDb(db);
  const dispatcher = new InlineDispatcher({ backoffMs: 5 });
  const runtime = createRuntime(config, { db, dispatcher });
  return {
    db,
    runtime,
    dispatcher,
    fake,
    async close() {
      await runtime.close();
      await db.$disconnect();
      await fake.close();
      unregister();
    },
  };
}

/* ---------------- synthetic AppView fixtures ---------------- */
export const FIXTURE_DID = 'did:plc:fixtureauthor000000000001';
export const FIXTURE_HANDLE = 'fixture.example.com';

export function fixtureProfile(followers = 1200) {
  return { did: FIXTURE_DID, handle: FIXTURE_HANDLE, displayName: 'Fixture Brand (SYNTHETIC)', description: 'synthetic test profile', followersCount: followers, followsCount: 10, postsCount: 3 };
}

/** likes=null → the AppView omits all counters for this post. */
export function fixturePost(rkey: string, createdAt: string, likes: number | null = 5) {
  return {
    post: {
      uri: `at://${FIXTURE_DID}/app.bsky.feed.post/${rkey}`,
      cid: `bafy${rkey}`,
      author: { did: FIXTURE_DID, handle: FIXTURE_HANDLE },
      record: { text: `synthetic post ${rkey} #livewallpaper`, createdAt, langs: ['en'] },
      ...(likes === null ? {} : { likeCount: likes, repostCount: 1, replyCount: 0, quoteCount: 0 }),
    },
  };
}
