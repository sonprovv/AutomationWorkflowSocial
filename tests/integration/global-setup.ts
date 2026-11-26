import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { migrateDeploy, startEmbeddedPostgres } from '@sss/database';

/**
 * Integration test infrastructure: an ephemeral embedded PostgreSQL 17 (real Postgres, no Docker)
 * with all committed migrations applied. Exposed to tests via `inject('databaseUrl')`.
 */
export default async function setup(project: TestProject) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sss-it-pg-'));
  const pg = await startEmbeddedPostgres({ dataDir, password: 'integration-test-only', persistent: false });
  await migrateDeploy(pg.url);
  project.provide('databaseUrl', pg.url);
  return async () => {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
