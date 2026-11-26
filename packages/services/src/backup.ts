import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { findRepoRoot } from '@sss/config';
import { createDb, Prisma, type Db } from '@sss/database';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';

/**
 * Encrypted logical backups (WF15, Master Plan §7.8, §15) — no pg_dump needed (the embedded PostgreSQL ships
 * without it), works the same against an external PostgreSQL.
 *
 * Backup:  one REPEATABLE READ snapshot → every table of schema `public` (incl. `_prisma_migrations`) as
 *          `row_to_json` text (types stay exact: values are never parsed in JS) → gzip → AES-256-GCM.
 *          A manifest records migrations, row counts and an order-independent checksum per table.
 * Restore: into a NEW, empty database (migrations applied, same migration list required) via
 *          `json_populate_recordset`, then sequences are reset and every table's count + checksum is verified.
 *          The running database is never overwritten; switching DATABASE_URL is a deliberate manual step.
 * Key:     BACKUP_PASSPHRASE (scrypt) or a random key generated once in .data/backup.key (keep a copy elsewhere —
 *          without it backups cannot be restored).
 * Rotation: the newest BACKUP_KEEP files are kept. Backups are not a reason to keep data past its retention:
 *          WF14 deletes data from the live DB and rotation ages old backups out.
 */

const MAGIC = Buffer.from('SSSBK1');
const BATCH = 2000;

export interface BackupManifest {
  format: 'sss-backup/v1';
  createdAt: string;
  migrations: string[];
  tables: { name: string; rows: number; checksum: string }[];
}

function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(findRepoRoot(), dir);
}

export function backupKey(passphrase: string | undefined, salt: Buffer, keyFile: string): Buffer {
  if (passphrase) return scryptSync(passphrase, salt, 32);
  if (!existsSync(keyFile)) {
    mkdirSync(join(keyFile, '..'), { recursive: true });
    writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
}

export function encrypt(plain: Buffer, passphrase: string | undefined, keyFile: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', backupKey(passphrase, salt, keyFile), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([passphrase ? 1 : 0]), salt, iv, body, c.getAuthTag()]);
}

export function decrypt(file: Buffer, passphrase: string | undefined, keyFile: string): Buffer {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new AppError('INVALID_INPUT', 'Not an SSS backup file');
  const usesPassphrase = file[MAGIC.length] === 1;
  if (usesPassphrase && !passphrase) throw new AppError('INVALID_INPUT', 'This backup was encrypted with BACKUP_PASSPHRASE; set it to restore');
  let o = MAGIC.length + 1;
  const salt = file.subarray(o, (o += 16));
  const iv = file.subarray(o, (o += 12));
  const tag = file.subarray(file.length - 16);
  const body = file.subarray(o, file.length - 16);
  const d = createDecipheriv('aes-256-gcm', backupKey(usesPassphrase ? passphrase : undefined, salt, keyFile), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new AppError('INVALID_INPUT', 'Backup decryption failed (wrong key/passphrase or the file was modified)');
  }
}

/** Order-independent checksum: sum of the first 8 bytes of each row's sha256, mod 2^64, plus the count. */
function rowDigest(rows: string[], acc: bigint): bigint {
  for (const r of rows) acc = (acc + createHash('sha256').update(r).digest().readBigUInt64BE(0)) & 0xffffffffffffffffn;
  return acc;
}

async function listTables(db: Db | Prisma.TransactionClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

/** Parents before children (foreign keys), so restore works without superuser rights. */
async function fkOrder(db: Db, tables: string[]): Promise<string[]> {
  const deps = await db.$queryRaw<{ child: string; parent: string }[]>`
    SELECT tc.relname AS child, tp.relname AS parent FROM pg_constraint c
    JOIN pg_class tc ON tc.oid = c.conrelid JOIN pg_class tp ON tp.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace WHERE c.contype = 'f' AND n.nspname = 'public'`;
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const d of deps.filter((x) => x.child === t && x.parent !== t)) visit(d.parent, stack);
    seen.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

async function tableDigest(db: Db | Prisma.TransactionClient, table: string): Promise<{ rows: string[][]; count: number; checksum: string }> {
  const batches: string[][] = [];
  let acc = 0n;
  let count = 0;
  for (let offset = 0; ; offset += BATCH) {
    const rows = await db.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM "${table}" t ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}`);
    const texts = rows.map((r) => r.j);
    acc = rowDigest(texts, acc);
    count += texts.length;
    batches.push(texts);
    if (rows.length < BATCH) break;
  }
  return { rows: batches, count, checksum: `${count}:${acc.toString(16)}` };
}

export class BackupService {
  constructor(private readonly ctx: ServiceContext) {}

  dir() {
    const d = resolveDir(this.ctx.config.BACKUP_DIR);
    mkdirSync(d, { recursive: true });
    return d;
  }

  keyFile() {
    return resolveDir(this.ctx.config.BACKUP_KEY_FILE);
  }

  async create(): Promise<{ file: string; bytes: number; manifest: BackupManifest; rotated: number }> {
    const { db, config } = this.ctx;
    const createdAt = nowOf(this.ctx);
    const lines: string[] = [];
    const manifest = await db.$transaction(
      async (tx) => {
        const tables = await listTables(tx);
        const migrations = (await tx.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`).map((m) => m.migration_name);
        const m: BackupManifest = { format: 'sss-backup/v1', createdAt: createdAt.toISOString(), migrations, tables: [] };
        for (const t of tables) {
          const d = await tableDigest(tx, t);
          m.tables.push({ name: t, rows: d.count, checksum: d.checksum });
          for (const batch of d.rows) for (const r of batch) lines.push(`${t}\t${r}`);
        }
        return m;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30 * 60_000, maxWait: 60_000 },
    );
    const plain = gzipSync(Buffer.from(`${JSON.stringify(manifest)}\n${lines.join('\n')}`, 'utf8'));
    const name = `sss-backup-${createdAt.toISOString().replace(/[:.]/g, '-')}.sssbk`;
    const file = join(this.dir(), name);
    writeFileSync(file, encrypt(plain, config.BACKUP_PASSPHRASE, this.keyFile()), { mode: 0o600 });
    const rotated = this.rotate();
    await db.auditLog.create({ data: { actor: 'system', action: 'backup.create', targetType: 'backup', targetId: name, metadata: { tables: manifest.tables.length, rows: manifest.tables.reduce((a, t) => a + t.rows, 0), rotated } } });
    return { file, bytes: statSync(file).size, manifest, rotated };
  }

  rotate(): number {
    const files = readdirSync(this.dir()).filter((f) => f.endsWith('.sssbk')).sort().reverse();
    const old = files.slice(this.ctx.config.BACKUP_KEEP);
    for (const f of old) rmSync(join(this.dir(), f), { force: true });
    return old.length;
  }

  list() {
    return readdirSync(this.dir())
      .filter((f) => f.endsWith('.sssbk'))
      .sort()
      .reverse()
      .map((f) => ({ name: f, bytes: statSync(join(this.dir(), f)).size }));
  }

  /** Read and decrypt a backup file; returns the manifest and a row iterator per table. */
  read(file: string): { manifest: BackupManifest; rows: Map<string, string[]> } {
    const plain = gunzipSync(decrypt(readFileSync(file), this.ctx.config.BACKUP_PASSPHRASE, this.keyFile())).toString('utf8');
    const nl = plain.indexOf('\n');
    const manifest = JSON.parse(nl === -1 ? plain : plain.slice(0, nl)) as BackupManifest;
    const rows = new Map<string, string[]>();
    if (nl !== -1) {
      for (const line of plain.slice(nl + 1).split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        const t = line.slice(0, tab);
        rows.set(t, [...(rows.get(t) ?? []), line.slice(tab + 1)]);
      }
    }
    return { manifest, rows };
  }
}

/**
 * Restore into an EMPTY database whose migrations match the backup (run migrateDeploy on it first), then verify.
 * Throws if the target already holds data or the migration list differs.
 */
export async function restoreInto(targetUrl: string, backup: { manifest: BackupManifest; rows: Map<string, string[]> }) {
  const db = createDb(targetUrl);
  try {
    const migrations = (await db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`).map((m) => m.migration_name);
    if (JSON.stringify(migrations) !== JSON.stringify(backup.manifest.migrations)) {
      throw new AppError('CONFLICT', `Target migrations differ from the backup (target ${migrations.length}, backup ${backup.manifest.migrations.length}); restore with the same app version`);
    }
    const tables = await listTables(db);
    for (const t of tables) {
      if (t === '_prisma_migrations') continue;
      const n = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${t}"`);
      if (Number(n[0]!.n) > 0) throw new AppError('CONFLICT', `Target table ${t} is not empty; restore only into a fresh database`);
    }
    const order = await fkOrder(db, backup.manifest.tables.map((t) => t.name).filter((t) => t !== '_prisma_migrations'));
    for (const t of order) {
      const rows = backup.rows.get(t) ?? [];
      for (let i = 0; i < rows.length; i += BATCH) {
        await db.$executeRawUnsafe(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, `[${rows.slice(i, i + BATCH).join(',')}]`);
      }
    }
    // Reset sequences (autoincrement ids) past the restored maximum.
    const seqs = await db.$queryRaw<{ table_name: string; column_name: string; seq: string }[]>`
      SELECT c.table_name, c.column_name, pg_get_serial_sequence(format('%I', c.table_name), c.column_name) AS seq
      FROM information_schema.columns c WHERE c.table_schema = 'public' AND pg_get_serial_sequence(format('%I', c.table_name), c.column_name) IS NOT NULL`;
    for (const s of seqs) {
      await db.$executeRawUnsafe(`SELECT setval('${s.seq}', COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 0) + 1, false)`);
    }
    // Verify every table.
    const verification: { table: string; expected: string; actual: string; ok: boolean }[] = [];
    for (const t of backup.manifest.tables) {
      if (t.name === '_prisma_migrations') continue; // compared by migration list above (timestamps differ by design)
      const d = await tableDigest(db, t.name);
      verification.push({ table: t.name, expected: t.checksum, actual: d.checksum, ok: d.checksum === t.checksum });
    }
    return { ok: verification.every((v) => v.ok), tables: verification.length, rows: backup.manifest.tables.reduce((a, t) => a + t.rows, 0), verification };
  } finally {
    await db.$disconnect();
  }
}
