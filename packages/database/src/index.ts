import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export * from './generated/prisma/client.ts';
export { startEmbeddedPostgres, freePort, type EmbeddedPgHandle, type EmbeddedPgOptions } from './embedded.ts';
export { migrateDeploy } from './migrate.ts';
export { seedProviders, loadCapabilityRecords } from './seed.ts';

export type Db = PrismaClient;

/** Create a Prisma client bound to `url` via the pg driver adapter (Prisma 7). */
export function createDb(url: string, opts: { max?: number } = {}): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, max: opts.max ?? 10 });
  return new PrismaClient({ adapter });
}

/** Lightweight readiness probe. */
export async function pingDb(db: PrismaClient): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}
