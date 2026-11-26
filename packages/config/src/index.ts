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
    PROVIDER_HEALTH_EVERY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
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
  for (const s of [r.data.YOUTUBE_API_KEY, r.data.BLUESKY_APP_PASSWORD]) globalSecrets.add(s);
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
