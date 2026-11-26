/**
 * Create a new migration from schema changes, using a throwaway embedded PostgreSQL
 * (no Docker / no local Postgres install needed).
 *
 *   npm run db:migrate:new -- <migration_name>
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../src/embedded.ts';

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: npm run db:migrate:new -- <snake_case_name>');
  process.exit(2);
}
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'sss-pg-'));
const pg = await startEmbeddedPostgres({ dataDir, password: 'migrate-dev-only', persistent: false });
try {
  const cli = join(pkgDir, '..', '..', 'node_modules', 'prisma', 'build', 'index.js');
  const r = spawnSync(process.execPath, [cli, 'migrate', 'dev', '--name', name], {
    cwd: pkgDir,
    env: { ...process.env, DATABASE_URL: pg.url },
    stdio: 'inherit',
  });
  process.exitCode = r.status ?? 1;
} finally {
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
