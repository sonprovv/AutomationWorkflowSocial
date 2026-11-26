import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { globalSecrets } from './redact.ts';

/**
 * Load `.env` from the repo root (if present) using Node's built-in loader (Node >= 21.7).
 * Existing process env vars win. Works identically on Windows and macOS.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const p = resolve(cwd, '.env');
  if (existsSync(p)) process.loadEnvFile(p);
}

/** Read an env var, trimming whitespace; empty string -> undefined. */
export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** Read a secret env var and register it for redaction. */
export function secretEnv(name: string): string | undefined {
  const v = env(name);
  globalSecrets.add(v);
  return v;
}

export function intEnv(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Env ${name} must be a non-negative integer, got "${v}"`);
  return n;
}
