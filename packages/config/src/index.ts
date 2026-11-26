import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { globalSecrets } from '@sss/collector-core';

/**
 * Central runtime configuration (Master Plan §15.1, §13).
 * - No hard-coded ports/URLs/secrets: everything comes from env with documented defaults.
 * - Secrets are registered for log redaction as soon as they are read.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Public web port (same-origin UI + /api proxy). Default 18966 per Master Plan §15.1. */
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(18966),
    /** Internal API port (behind the web proxy). */
    API_PORT: z.coerce.number().int().min(1).max(65535).default(18967),
    /** Bind address. Local-only by default (§11, §13). */
    API_HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.preprocess(emptyToUndef, z.string().startsWith('postgres').optional()),
    REDIS_URL: z.preprocess(emptyToUndef, z.string().startsWith('redis').default('redis://127.0.0.1:6379')),
    /** bullmq (default) or inline (dev/test only: runs jobs in-process, refused in production). */
    QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('bullmq'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),
    MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    INITIAL_POSTS_PER_ACCOUNT: z.coerce.number().int().min(1).max(200).default(20),
    /** Max posts whose metrics one refresh job updates (WF05/06); the most overdue go first. */
    METRICS_REFRESH_MAX_POSTS: z.coerce.number().int().min(1).max(5000).default(500),
    PROVIDER_HEALTH_EVERY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    /** Run the scheduler tick inside the API process when QUEUE_DRIVER=inline (dev mode without Redis). */
    SCHEDULER_IN_PROCESS: bool.default(true),
    SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /** Max account syncs the scheduler queues per WF04 run. */
    SCHEDULER_MAX_SYNCS_PER_TICK: z.coerce.number().int().min(1).max(500).default(20),
    /** WF14: delete posts the provider stopped returning after this grace period (Bluesky Developer Guidelines). */
    CLEANUP_DELETE_UNAVAILABLE: bool.default(true),
    CLEANUP_UNAVAILABLE_GRACE_HOURS: z.coerce.number().int().min(1).max(8760).default(72),
    /** Export files (WF17). Relative paths are resolved from the repository root. */
    EXPORT_DIR: z.string().default('.data/exports'),
    EXPORT_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    EXPORT_MAX_POSTS: z.coerce.number().int().min(1).max(500_000).default(50_000),
    /** WF08 AI analysis (Claude Messages API). Without a key the AI job reports AUTH_REQUIRED. */
    ANTHROPIC_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
    AI_MODEL: z.string().default('claude-opus-5-5'),
    AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    /** Server-side refusal fallback (beta) — on by default. */
    AI_FALLBACKS: bool.default(true),
    /** Tests only: point the SDK at a local fake API. */
    AI_BASE_URL: z.preprocess(emptyToUndef, z.string().url().optional()),
    /** Price per million tokens used for cost accounting/budgets (configurable; check current pricing). */
    AI_INPUT_USD_PER_MTOK: z.coerce.number().min(0).default(4),
    AI_OUTPUT_USD_PER_MTOK: z.coerce.number().min(0).default(20),
    /** Hard cap on AI analyses per UTC day across all projects. */
    AI_DAILY_MAX_ANALYSES: z.coerce.number().int().min(0).max(10_000).default(50),
    /** Provider credentials (optional; adapters report AUTH_REQUIRED when missing). */
    YOUTUBE_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
    BLUESKY_IDENTIFIER: z.preprocess(emptyToUndef, z.string().optional()),
    BLUESKY_APP_PASSWORD: z.preprocess(emptyToUndef, z.string().optional()),
    /** Per-day provider caps used by the Phase 1 guard (full budget engine: Phase 4). */
    YOUTUBE_DAILY_QUOTA_UNITS: z.coerce.number().int().min(0).default(8000),
    BLUESKY_DAILY_REQUESTS: z.coerce.number().int().min(0).default(20000),
    OPEN_BROWSER: bool.default(true),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.QUEUE_DRIVER === 'inline') {
      ctx.addIssue({ code: 'custom', path: ['QUEUE_DRIVER'], message: 'inline queue driver is not allowed in production' });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/** Walk up from `start` to the repo root (folder containing package-lock.json). */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'package-lock.json')) && existsSync(join(dir, 'SOCIAL_SPY_AUTOMATION_PLAN.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { reload?: boolean; loadDotEnv?: boolean } = {}): AppConfig {
  if (cached && !opts.reload && env === process.env) return cached;
  if (opts.loadDotEnv !== false && env === process.env) {
    const p = join(findRepoRoot(), '.env');
    if (existsSync(p)) process.loadEnvFile(p);
  }
  const r = configSchema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  for (const s of [r.data.YOUTUBE_API_KEY, r.data.BLUESKY_APP_PASSWORD, r.data.ANTHROPIC_API_KEY]) globalSecrets.add(s);
  // Database URLs may embed passwords.
  const pw = r.data.DATABASE_URL ? safePassword(r.data.DATABASE_URL) : undefined;
  globalSecrets.add(pw);
  if (env === process.env) cached = r.data;
  return r.data;
}

function safePassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

export function requireDatabaseUrl(c: AppConfig): string {
  if (!c.DATABASE_URL) throw new Error('DATABASE_URL is not set (run via start script or set it in .env)');
  return c.DATABASE_URL;
}
