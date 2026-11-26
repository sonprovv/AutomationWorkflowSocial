import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Embedded PostgreSQL (npm `embedded-postgres`, official PostgreSQL binaries per OS/arch).
 * Used for: integration tests (ephemeral) and the Docker-free "native" local mode (persistent).
 * See ADR-0008. Binds to 127.0.0.1 only.
 */
export interface EmbeddedPgOptions {
  dataDir: string;
  port?: number;
  user?: string;
  password: string;
  database?: string;
  persistent: boolean;
}

export interface EmbeddedPgHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

export async function startEmbeddedPostgres(o: EmbeddedPgOptions): Promise<EmbeddedPgHandle> {
  const port = o.port ?? (await freePort());
  const user = o.user ?? 'sss';
  const database = o.database ?? 'social_spy';
  const fresh = !existsSync(o.dataDir) || !existsSync(`${o.dataDir}/PG_VERSION`);
  mkdirSync(o.dataDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: o.dataDir,
    port,
    user,
    password: o.password,
    persistent: o.persistent,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    // Force UTF-8 + ICU: on Windows initdb otherwise defaults to WIN1252 (rejects emoji/CJK), and the C
    // locale cannot case-fold Vietnamese ("TIẾNG" ILIKE "tiếng" = false). Same flags as the Docker image.
    initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) {
    try {
      await pg.createDatabase(database);
    } catch (e) {
      if (!/already exists/i.test(String(e))) throw e;
    }
  }
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(o.password)}@127.0.0.1:${port}/${database}`;
  return { url, port, stop: () => pg.stop() };
}
