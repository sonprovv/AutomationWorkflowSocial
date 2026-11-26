import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { findRepoRoot } from '@sss/config';

export const ROOT = findRepoRoot();
export const DATA_DIR = join(ROOT, '.data');
export const RUN_DIR = join(DATA_DIR, 'run');
export const PG_DIR = join(DATA_DIR, 'postgres');
export const STATE_FILE = join(RUN_DIR, 'state.json');
export const STOP_FILE = join(RUN_DIR, 'stop.request');

export interface RunState {
  supervisorPid: number;
  startedAt: string;
  url: string;
  mode: 'native' | 'docker';
  queueDriver: 'bullmq' | 'inline';
  services: { name: string; pid: number | undefined }[];
}

export function readState(): RunState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
  } catch {
    return null;
  }
}

export function writeState(s: RunState): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function clearState(): void {
  rmSync(STATE_FILE, { force: true });
  rmSync(STOP_FILE, { force: true });
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Local embedded-Postgres password: random, generated once, stored only in the git-ignored .data folder. */
export function localDbPassword(): string {
  const f = join(DATA_DIR, 'postgres.secret');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  mkdirSync(DATA_DIR, { recursive: true });
  const pw = randomBytes(24).toString('base64url');
  writeFileSync(f, pw, { mode: 0o600 });
  return pw;
}
