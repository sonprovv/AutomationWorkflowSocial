#!/usr/bin/env node
/** Environment diagnostics (Master Plan §15.1 `doctor`). Read-only: never changes anything. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@sss/config';
import { nodeVersionOk, portFree, redisReachable } from './checks.ts';
import { isAlive, readState, ROOT } from './runtime-files.ts';

const rows: [string, 'OK' | 'WARN' | 'FAIL', string][] = [];
const add = (k: string, s: 'OK' | 'WARN' | 'FAIL', d: string) => rows.push([k, s, d]);

const nv = nodeVersionOk();
add('Node.js', nv.ok ? 'OK' : 'FAIL', `${nv.version} (need >= 22.12)`);
add('Dependencies', existsSync(join(ROOT, 'node_modules')) ? 'OK' : 'FAIL', existsSync(join(ROOT, 'node_modules')) ? 'installed' : 'run: npm ci');
add('.env', existsSync(join(ROOT, '.env')) ? 'OK' : 'WARN', existsSync(join(ROOT, '.env')) ? 'present' : 'missing (start will create it from .env.example)');

let config;
try {
  config = loadConfig();
  add('Config', 'OK', `APP_PORT=${config.APP_PORT}, timezone=${config.APP_TIMEZONE}`);
} catch (e) {
  add('Config', 'FAIL', (e as Error).message);
}
if (config) {
  const st = readState();
  const running = st && isAlive(st.supervisorPid);
  const free = await portFree(config.APP_PORT);
  add('Port', free || running ? 'OK' : 'FAIL', running ? `${config.APP_PORT} used by this app (running at ${st!.url})` : free ? `${config.APP_PORT} free` : `${config.APP_PORT} busy (another program) → set APP_PORT in .env`);
  const r = await redisReachable(config.REDIS_URL);
  add('Redis', r.ok ? 'OK' : 'WARN', r.ok ? `reachable (${r.version ?? '?'})` : `not reachable at ${config.REDIS_URL} → inline mode (no worker/scheduler). Install: winget install Memurai.MemuraiDeveloper | brew install redis`);
  add('Database', 'OK', config.DATABASE_URL ? 'external DATABASE_URL configured' : 'embedded PostgreSQL (.data/postgres)');
  add('YouTube', config.YOUTUBE_API_KEY ? 'OK' : 'WARN', config.YOUTUBE_API_KEY ? 'API key configured' : 'YOUTUBE_API_KEY not set (YouTube adapter disabled)');
  add('Bluesky', 'OK', config.BLUESKY_APP_PASSWORD ? 'App Password configured (search pagination enabled)' : 'public API (no credentials needed)');
}
const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, s, d] of rows) console.log(`${s.padEnd(4)}  ${k.padEnd(w)}  ${d}`);
process.exitCode = rows.some((r) => r[1] === 'FAIL') ? 1 : 0;
