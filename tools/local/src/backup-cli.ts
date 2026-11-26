#!/usr/bin/env node
/**
 * Backup / restore CLI (Phase 8).
 *
 *   npm run backup                       create an encrypted backup now (app must be running in native mode,
 *                                        or DATABASE_URL must point at the database)
 *   npm run backup -- list               list backups
 *   npm run backup -- verify [file]      restore test: restore the newest (or given) backup into a temporary
 *                                        database, verify every table, then drop that database
 *   npm run backup -- restore <file>     restore into a NEW database "<db>_restore_<time>" on the same server and
 *                                        verify every table. The live database is not touched; to switch, stop the
 *                                        app and point DATABASE_URL at the restored database (docs/RUNBOOK.md).
 */
import { basename, isAbsolute, join } from 'node:path';
import { loadConfig } from '@sss/config';
import { createDb, migrateDeploy } from '@sss/database';
import { BackupService, createRuntime, restoreInto } from '@sss/services';
import { localDbPassword, ROOT } from './runtime-files.ts';

const config = loadConfig();
const databaseUrl = config.DATABASE_URL ?? `postgresql://sss:${encodeURIComponent(localDbPassword())}@127.0.0.1:${process.env.EMBEDDED_PG_PORT ?? 18968}/social_spy`;
const rt = createRuntime({ ...config, DATABASE_URL: databaseUrl, QUEUE_DRIVER: 'inline' });
const svc = new BackupService(rt.ctx);
const [cmd, arg] = process.argv.slice(2);
try {
  if (!cmd || cmd === 'create') {
    const r = await svc.create();
    console.log(`Backup written: ${r.file} (${Math.ceil(r.bytes / 1024)} KB, ${r.manifest.tables.length} tables, ${r.manifest.tables.reduce((a, t) => a + t.rows, 0)} rows; rotated ${r.rotated})`);
    if (!config.BACKUP_PASSPHRASE) console.log(`Key file: ${svc.keyFile()} — keep a copy somewhere else; without it this backup cannot be restored.`);
  } else if (cmd === 'list') {
    for (const b of svc.list()) console.log(`${b.name}  ${Math.ceil(b.bytes / 1024)} KB`);
  } else if (cmd === 'restore' || cmd === 'verify') {
    const pick = arg ?? (cmd === 'verify' ? svc.list()[0]?.name : undefined);
    if (!pick) throw new Error(cmd === 'verify' ? 'No backup found — run "npm run backup" first' : 'Usage: npm run backup -- restore <file>');
    const arg2 = pick;
    const file = isAbsolute(arg2) ? arg2 : existsInBackups(arg2) ? join(svc.dir(), basename(arg2)) : join(ROOT, arg2);
    const backup = svc.read(file);
    const u = new URL(databaseUrl);
    const name = `${u.pathname.slice(1)}_${cmd === 'verify' ? 'verify' : 'restore'}_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const admin = createDb(databaseUrl);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.$disconnect();
    u.pathname = `/${name}`;
    await migrateDeploy(u.toString());
    const r = await restoreInto(u.toString(), backup);
    for (const v of r.verification) console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${v.table}  ${v.actual}`);
    console.log(r.ok ? `Restored and verified into database "${name}" (${r.rows} rows from ${basename(file)}).` : `Verification FAILED for database "${name}".`);
    if (!r.ok) process.exitCode = 1;
    if (cmd === 'verify') {
      const dropper = createDb(databaseUrl);
      await dropper.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await dropper.$disconnect();
      console.log(`Restore test ${r.ok ? 'PASSED' : 'FAILED'}; temporary database dropped.`);
    }
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
} finally {
  await rt.close();
}

function existsInBackups(f: string) {
  return svc.list().some((b) => b.name === basename(f));
}
