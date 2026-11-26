#!/usr/bin/env node
/**
 * Native local runtime supervisor (default mode, no Docker) — Master Plan §15.1, ADR-0008.
 *
 *  start.bat / start.command  →  this script:
 *   1. checks Node, .env, port (never kills other processes)
 *   2. starts embedded PostgreSQL (persistent, .data/postgres) unless DATABASE_URL is set
 *   3. applies migrations + seeds providers/policies
 *   4. Redis reachable → api + worker + scheduler (BullMQ); otherwise api with the inline queue (dev mode)
 *   5. waits for /api/v1/health/ready, prints the real URL, opens the browser
 *  Stop with Ctrl+C in this window or stop.bat / stop.command (graceful, data kept).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@sss/config';
import { createDb, migrateDeploy, startEmbeddedPostgres, type EmbeddedPgHandle } from '@sss/database';
import { seedFromCapabilityRecords } from '@sss/services';
import { nodeVersionOk, portFree, redisReachable, waitForHttp } from './checks.ts';
import { clearState, isAlive, localDbPassword, PG_DIR, readState, ROOT, STOP_FILE, writeState } from './runtime-files.ts';

const log = (m: string) => console.log(`[start] ${m}`);
let shuttingDown = false;
const fail = (m: string): never => {
  console.error(`\n[start] ERROR: ${m}\n`);
  process.exit(1);
};

const nv = nodeVersionOk();
if (!nv.ok) fail(`Node.js >= 22.12 is required (found ${nv.version}). Install Node 22 LTS from https://nodejs.org`);

if (!existsSync(join(ROOT, '.env'))) {
  copyFileSync(join(ROOT, '.env.example'), join(ROOT, '.env'));
  log('Created .env from .env.example (edit it to add API keys; never commit it).');
}
const config = loadConfig();
const port = config.APP_PORT;
const url = `http://127.0.0.1:${port}`;

// Already running?
const prev = readState();
if (prev && isAlive(prev.supervisorPid)) {
  log(`Already running (pid ${prev.supervisorPid}) at ${prev.url}`);
  if (config.OPEN_BROWSER) openBrowser(prev.url);
  process.exit(0);
}
clearState();

if (!(await portFree(port))) {
  fail(`Port ${port} is already in use by another program. Set APP_PORT=<free port> in .env (e.g. APP_PORT=18970) and run start again. This script never stops other programs.`);
}

// 1) Database
let pg: EmbeddedPgHandle | null = null;
let databaseUrl = config.DATABASE_URL;
if (!databaseUrl) {
  const pgPort = Number(process.env.EMBEDDED_PG_PORT ?? 18968);
  if (!(await portFree(pgPort)) && !existsSync(join(PG_DIR, 'postmaster.pid'))) {
    fail(`Port ${pgPort} (embedded PostgreSQL) is in use. Set EMBEDDED_PG_PORT=<free port> in .env.`);
  }
  rmSync(join(PG_DIR, 'postmaster.pid'), { force: true }); // stale lock after a crash/power loss
  log(`Starting embedded PostgreSQL on 127.0.0.1:${pgPort} (data: .data/postgres)…`);
  pg = await startEmbeddedPostgres({ dataDir: PG_DIR, port: pgPort, password: localDbPassword(), persistent: true });
  databaseUrl = pg.url;
}
log('Applying database migrations…');
await migrateDeploy(databaseUrl!);
{
  const db = createDb(databaseUrl!);
  const seeded = await seedFromCapabilityRecords(db);
  await db.$disconnect();
  log(`Providers: ${seeded.filter((s) => s.enabled).map((s) => s.providerId).join(', ') || 'none enabled'} enabled; ${seeded.length} known.`);
}

// 2) Queue
const redis = await redisReachable(config.REDIS_URL);
const queueDriver: 'bullmq' | 'inline' = redis.ok ? 'bullmq' : 'inline';
if (redis.ok) log(`Redis ${redis.version ?? ''} reachable → worker + scheduler mode.`);
else {
  log(`Redis not reachable at ${config.REDIS_URL} → INLINE mode: jobs run inside the API process; scheduled workflows are disabled.`);
  log('  For full mode install a Redis-compatible server, e.g. Windows: winget install Memurai.MemuraiDeveloper · macOS: brew install redis && brew services start redis');
}

// 3) Web build (if the UI exists and is not built yet)
if (existsSync(join(ROOT, 'apps', 'web', 'package.json')) && !existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
  log('Building web UI (first run)…');
  await runOnce(['run', 'build', '-w', '@sss/web']);
}

// 4) Services
const childEnv = { ...process.env, DATABASE_URL: databaseUrl, QUEUE_DRIVER: queueDriver, API_HOST: '127.0.0.1', API_PORT: String(port), SERVE_WEB: 'true', NODE_ENV: 'production' };
if (queueDriver === 'inline') childEnv.NODE_ENV = 'development'; // inline driver is refused in production
const children: { name: string; proc: ChildProcess }[] = [];
const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
function startService(name: string, entry: string) {
  const proc = spawn(process.execPath, [tsx, entry], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  proc.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[start] ${name} exited unexpectedly (code ${code}). Stopping everything.`);
      void shutdown(1);
    }
  });
  children.push({ name, proc });
}
startService('api', 'apps/api/src/main.ts');
if (queueDriver === 'bullmq') {
  startService('worker', 'apps/worker/src/main.ts');
  startService('scheduler', 'apps/scheduler/src/main.ts');
}

writeState({
  supervisorPid: process.pid,
  startedAt: new Date().toISOString(),
  url,
  mode: 'native',
  queueDriver,
  services: children.map((c) => ({ name: c.name, pid: c.proc.pid })),
});

if (!(await waitForHttp(`${url}/api/v1/health/ready`, 60_000))) {
  console.error('[start] API did not become ready within 60s. See the log above.');
  await shutdown(1);
}
console.log(`\n  Social Spy Automation is running → ${url}\n  API docs → ${url}/api/docs\n  Mode: native, queue: ${queueDriver}. Stop: Ctrl+C here, or stop.bat / stop.command\n`);
if (config.OPEN_BROWSER) openBrowser(url);

// 5) Stop handling: Ctrl+C, or stop.request file written by stop.bat/stop.command (works on Windows too).
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Stopping services (graceful)…');
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.proc.exitCode !== null) return resolve();
          const t = setTimeout(() => {
            killTree(c.proc);
            resolve();
          }, 15_000);
          c.proc.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
          c.proc.send?.({ type: 'shutdown' });
        }),
    ),
  );
  if (pg) {
    log('Stopping embedded PostgreSQL…');
    await pg.stop().catch(() => {});
  }
  clearState();
  log('Stopped. Data is kept in .data/');
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
setInterval(() => {
  if (existsSync(STOP_FILE)) void shutdown(0);
}, 1000).unref();
// Keep the supervisor alive.
setInterval(() => {}, 1 << 30);

/** tsx runs the service in a grandchild process; on Windows proc.kill() would only end the tsx wrapper. */
function killTree(proc: ChildProcess) {
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill();
  }
}

function openBrowser(target: string) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

function runOnce(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = spawn(npm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} failed (${c})`))));
  });
}
