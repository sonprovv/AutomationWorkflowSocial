#!/usr/bin/env node
/**
 * Phase 0 feasibility PoC CLI.
 *
 *   npm run poc -- bluesky            # real calls to the Bluesky public AppView
 *   npm run poc -- youtube            # real calls to YouTube Data API v3 (needs YOUTUBE_API_KEY in .env)
 *   npm run poc -- youtube --label morning
 *   npm run poc -- bluesky --dry-run  # print plan + budget only, no network
 *
 * Output (secrets redacted): docs/feasibility/runs/<platform>/<timestamp>.json
 *                            docs/feasibility/samples/<platform>.sample.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform as osPlatform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UsageMeter,
  env,
  intEnv,
  loadDotEnv,
  redactDeep,
  secretEnv,
  type Account,
  type PlatformAdapter,
  type Post,
  type RequestLogEntry,
} from '@sss/collector-core';
import { BlueskyAdapter } from '@sss/collector-bluesky';
import { YouTubeAdapter } from '@sss/collector-youtube';
import { runFeasibility, type RunOutcome, type Targets, type TestResult } from './runner.ts';
import { latencyStats } from './stats.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SUPPORTED = ['bluesky', 'youtube'] as const;
type Supported = (typeof SUPPORTED)[number];

function parseArgs(argv: string[]) {
  const [platform, ...rest] = argv;
  const label = rest.includes('--label') ? rest[rest.indexOf('--label') + 1] : undefined;
  return { platform, label, dryRun: rest.includes('--dry-run') };
}

interface Built {
  adapter: PlatformAdapter;
  invalid?: PlatformAdapter;
  meter: UsageMeter;
  credentialsConfigured: boolean;
  mediaHosts: string[];
  provider: string;
  credentialOnly: boolean;
}

function build(p: Supported, log: RequestLogEntry[]): Built {
  const onLog = (e: RequestLogEntry) => log.push(e);
  if (p === 'bluesky') {
    const identifier = env('BLUESKY_IDENTIFIER');
    const appPassword = secretEnv('BLUESKY_APP_PASSWORD');
    const meter = new UsageMeter({ maxRequests: intEnv('BLUESKY_POC_MAX_REQUESTS', 200) });
    const creds = Boolean(identifier && appPassword);
    return {
      adapter: new BlueskyAdapter({ meter, identifier, appPassword, onLog }),
      // Negative test only when an App Password is configured (avoids pointless createSession calls).
      invalid: creds ? new BlueskyAdapter({ meter, identifier, appPassword: 'invalid-app-password-0000', onLog }) : undefined,
      meter,
      credentialsConfigured: creds,
      mediaHosts: ['cdn.bsky.app', 'video.bsky.app', 'video.cdn.bsky.app'],
      provider: 'bluesky-appview',
      credentialOnly: false,
    };
  }
  const apiKey = secretEnv('YOUTUBE_API_KEY');
  const meter = new UsageMeter({ maxQuotaUnits: intEnv('YOUTUBE_POC_MAX_UNITS', 1500), maxRequests: 400 });
  return {
    adapter: new YouTubeAdapter({ apiKey, meter, onLog }),
    // A syntactically plausible but invalid key: exercises live error classification (costs ≥1 quota unit
    // only on a real project; an invalid key is rejected before any project quota is charged).
    invalid: new YouTubeAdapter({ apiKey: 'AIzaSyINVALID-poc-negative-test-000000', meter, onLog }),
    meter,
    credentialsConfigured: Boolean(apiKey),
    mediaHosts: ['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'],
    provider: 'youtube-data-api-v3',
    credentialOnly: !apiKey,
  };
}

async function main() {
  loadDotEnv(ROOT);
  const args = parseArgs(process.argv.slice(2));
  if (!SUPPORTED.includes(args.platform as Supported)) {
    console.error(`Usage: npm run poc -- <${SUPPORTED.join('|')}> [--label name] [--dry-run]`);
    console.error('Other platforms are documented in docs/feasibility/ (AUTH_REQUIRED / BLOCKED / LEGAL_RISK).');
    process.exit(2);
  }
  const p = args.platform as Supported;
  const targets: Targets = JSON.parse(readFileSync(join(ROOT, 'tools/feasibility/targets', `${p}.json`), 'utf8'));
  const requestLog: RequestLogEntry[] = [];
  const b = build(p, requestLog);
  console.log(`[poc] platform=${p} provider=${b.provider} credentials=${b.credentialsConfigured ? 'configured' : 'none'} limits=${JSON.stringify(b.meter.snapshot().limits)}`);
  if (args.dryRun) {
    console.log('[poc] dry run — targets:', JSON.stringify(targets, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  let outcome: RunOutcome;
  let runStatus: string;
  if (b.credentialOnly) {
    // No credential: only verify that the missing/invalid-credential paths are classified correctly.
    console.log('[poc] YOUTUBE_API_KEY not set — running credential checks only (status AUTH_REQUIRED).');
    const tests: TestResult[] = [];
    const t0 = performance.now();
    const c = await b.adapter.validateCredentials();
    tests.push({ id: 'TC02a', name: 'validateCredentials (configured)', status: c.state === 'MISSING' ? 'SKIP' : 'FAIL', durationMs: Math.round(performance.now() - t0), message: c.message, data: { state: c.state } });
    const t1 = performance.now();
    const bad = await b.invalid!.validateCredentials();
    tests.push({ id: 'TC02b', name: 'validateCredentials (deliberately invalid) is classified', status: bad.state === 'INVALID' ? 'PASS' : 'FAIL', durationMs: Math.round(performance.now() - t1), message: bad.message, data: { state: bad.state } });
    outcome = { tests, accounts: [], posts: [], idsObserved: { resolved: {}, postsByAccount: {}, searchPostIds: {} }, media: [] };
    runStatus = 'AUTH_REQUIRED';
  } else {
    outcome = await runFeasibility(b.adapter, targets, { meter: b.meter, requestLog, invalidCredentialAdapter: b.invalid, mediaHosts: b.mediaHosts });
    const failed = outcome.tests.filter((t) => t.status === 'FAIL').length;
    runStatus = failed === 0 ? 'COMPLETED' : 'COMPLETED_WITH_FAILURES';
  }
  const endedAt = new Date().toISOString();
  const usage = b.meter.snapshot();

  const report = redactDeep({
    schema: 'sss.feasibility-run/v1',
    runId: `${p}-${startedAt.replace(/[:.]/g, '-')}`,
    label: args.label ?? null,
    platform: p,
    provider: b.provider,
    status: runStatus,
    startedAt,
    endedAt,
    environment: { node: process.version, os: `${osPlatform()} ${release()} ${arch()}` },
    credentialsConfigured: b.credentialsConfigured,
    usage: { ...usage, costUsd: 0, costNote: p === 'youtube' ? 'No monetary cost; quota units only (upper-bound accounting for search).' : 'Public API, no monetary cost.' },
    summary: {
      tests: outcome.tests.length,
      pass: outcome.tests.filter((t) => t.status === 'PASS').length,
      fail: outcome.tests.filter((t) => t.status === 'FAIL').length,
      skip: outcome.tests.filter((t) => t.status === 'SKIP').length,
      requests: latencyStats(requestLog),
    },
    tests: outcome.tests,
    idsObserved: outcome.idsObserved,
    media: outcome.media,
    requestLog,
    dataHandling:
      p === 'youtube'
        ? 'Contains YouTube Non-Authorized Data identifiers/stats. Per Developer Policies III.E.4: delete or refresh within 30 days of startedAt.'
        : 'Contains public Bluesky identifiers. Honor deletions: remove if an author deletes content/account.',
    deleteBy: p === 'youtube' ? new Date(Date.parse(startedAt) + 30 * 86400_000).toISOString() : null,
  });

  const runDir = join(ROOT, 'docs/feasibility/runs', p);
  mkdirSync(runDir, { recursive: true });
  const runFile = join(runDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(runFile, JSON.stringify(report, null, 2) + '\n');

  if (outcome.accounts.length || outcome.posts.length) writeSample(p, startedAt, outcome.accounts, outcome.posts);

  for (const t of outcome.tests) {
    console.log(`${t.status.padEnd(4)} ${t.id.padEnd(10)} ${t.name}${t.errorCode ? ` [${t.errorCode}]` : ''}${t.status === 'FAIL' && t.message ? ` — ${t.message}` : ''}`);
  }
  console.log(`[poc] ${runStatus} pass=${report.summary.pass} fail=${report.summary.fail} skip=${report.summary.skip} requests=${usage.requests} quotaUnits=${usage.quotaUnits}`);
  console.log(`[poc] report: ${runFile}`);
}

/** Small, truncated sample of NORMALIZED records (not raw dumps) for documentation. */
function writeSample(p: Supported, collectedAt: string, accounts: Account[], posts: Post[]) {
  const trunc = (s: string | null, n = 280) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
  const sample = {
    _sample: {
      kind: 'REAL normalized records from the latest PoC run (truncated). Not a fixture.',
      platform: p,
      collectedAt,
      deleteBy: p === 'youtube' ? new Date(Date.parse(collectedAt) + 30 * 86400_000).toISOString() : null,
      policyNote: p === 'youtube' ? 'YouTube Non-Authorized Data: refresh or delete within 30 days.' : 'Public Bluesky content: remove on author deletion.',
    },
    account: accounts[0] ? { ...accounts[0], bio: trunc(accounts[0].bio, 160) } : null,
    posts: posts.slice(0, 2).map((x) => ({ ...x, caption: trunc(x.caption) })),
  };
  const dir = join(ROOT, 'docs/feasibility/samples');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p}.sample.json`), JSON.stringify(redactDeep(sample), null, 2) + '\n');
}

main().catch((e) => {
  console.error('[poc] fatal:', e);
  process.exit(1);
});
