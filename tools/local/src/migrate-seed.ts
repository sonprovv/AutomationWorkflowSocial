#!/usr/bin/env node
/** One-shot: apply migrations + seed providers/policies (Docker `migrate` service, CI, external DBs). */
import { loadConfig, requireDatabaseUrl } from '@sss/config';
import { createDb, migrateDeploy } from '@sss/database';
import { seedFromCapabilityRecords } from '@sss/services';

const url = requireDatabaseUrl(loadConfig());
await migrateDeploy(url);
const db = createDb(url);
const seeded = await seedFromCapabilityRecords(db);
await db.$disconnect();
console.log(`[migrate] migrations applied; providers seeded: ${seeded.map((s) => `${s.providerId}${s.enabled ? '*' : ''}`).join(', ')} (* = enabled)`);
