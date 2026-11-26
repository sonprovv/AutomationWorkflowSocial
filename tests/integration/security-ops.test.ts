/**
 * Phase 8 — security headers & token auth, config guard for remote exposure, Prometheus metrics,
 * encrypted backup → restore into a fresh database with verification. SYNTHETIC provider data.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { configSchema } from '@sss/config';
import { migrateDeploy } from '@sss/database';
import { BackupService, restoreInto } from '@sss/services';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, FIXTURE_DID, fixturePost, fixtureProfile, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
let tmp: string | undefined;
afterEach(async () => {
  await app?.close();
  await h?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});
const ROUTES = {
  '/xrpc/app.bsky.actor.getProfile': () => ({ body: fixtureProfile() }),
  '/xrpc/app.bsky.feed.getAuthorFeed': () => ({ body: { feed: [fixturePost('3s1', '2026-11-25T01:00:00.000Z', 4), fixturePost('3s2', '2026-11-25T02:00:00.000Z', null)] } }),
};

describe('security', () => {
  it('sends hardening headers and requires the bearer token when API_TOKEN is set', async () => {
    const token = 'tok_0123456789abcdefghijklmnop';
    h = await createHarness(ROUTES, { API_TOKEN: token });
    app = await buildServer({ runtime: h.runtime });
    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.headers).toMatchObject({ 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    expect(live.headers['content-security-policy']).toMatch(/default-src 'self'.*frame-ancestors 'none'/);
    expect(live.headers['access-control-allow-origin']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${token}x` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it('refuses to expose the API beyond loopback without a token', () => {
    expect(() => configSchema.parse({ API_HOST: '0.0.0.0' })).toThrow(/API_TOKEN/);
    expect(configSchema.parse({ API_HOST: '0.0.0.0', API_TOKEN: 'x'.repeat(24) }).API_HOST).toBe('0.0.0.0');
    expect(configSchema.parse({ API_HOST: '0.0.0.0', API_CONTAINER_NETWORK: 'true' }).API_HOST).toBe('0.0.0.0');
    expect(configSchema.parse({}).API_HOST).toBe('127.0.0.1');
  });
});

describe('observability', () => {
  it('exposes Prometheus metrics for HTTP, jobs, posts and provider usage', async () => {
    h = await createHarness(ROUTES);
    app = await buildServer({ runtime: h.runtime });
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID } });
    await h.dispatcher.drain();
    await app.inject({ method: 'GET', url: '/api/v1/posts' });
    const m = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(m.headers['content-type']).toMatch(/text\/plain/);
    expect(m.body).toMatch(/sss_http_requests_total\{method="GET",route="\/api\/v1\/posts",status="2xx"\} 1/);
    expect(m.body).toMatch(/sss_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/posts",le="\+Inf"\} 1/);
    expect(m.body).toMatch(/sss_posts\{status="AVAILABLE"\} 2/);
    expect(m.body).toMatch(/sss_provider_usage_today\{provider="bluesky-appview",unit="requests"\} 3/);
    expect(m.body).toMatch(/sss_jobs_active\{status="QUEUED"\} 0/);
  });
});

describe('encrypted backup and verified restore', () => {
  async function freshDb(name: string) {
    await h.db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await h.db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const u = new URL(h.runtime.ctx.config.DATABASE_URL!);
    u.pathname = `/${name}`;
    await migrateDeploy(u.toString());
    return u.toString();
  }

  it('backs up every table encrypted, restores into a fresh database, and verifies counts + checksums', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sss-backup-test-'));
    h = await createHarness(ROUTES, { BACKUP_DIR: join(tmp, 'b'), BACKUP_KEY_FILE: join(tmp, 'k', 'backup.key'), BACKUP_KEEP: '2' });
    app = await buildServer({ runtime: h.runtime });
    const pr = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Hình nền 🎉 "quoted"' } })).body);
    await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { input: FIXTURE_DID, projectId: pr.id } });
    await h.dispatcher.drain();
    const svc = new BackupService(h.runtime.ctx);
    const b = await svc.create();
    expect(b.manifest.tables.find((t) => t.name === 'posts')).toMatchObject({ rows: 2 });
    const raw = readFileSync(b.file);
    expect(raw.toString('latin1')).not.toContain('Hình'); // encrypted at rest
    expect(raw.toString('latin1')).not.toContain('fixture.example.com');

    const target = await freshDb('restore_check_1');
    const r = await restoreInto(target, svc.read(b.file));
    expect(r.ok).toBe(true);
    expect(r.verification.find((v) => v.table === 'projects')).toMatchObject({ ok: true });
    expect(r.verification.find((v) => v.table === 'post_metrics')).toMatchObject({ ok: true });

    // Refuses a non-empty target; detects tampering; rotation keeps BACKUP_KEEP files.
    await expect(restoreInto(target, svc.read(b.file))).rejects.toMatchObject({ code: 'CONFLICT' });
    const t = Buffer.from(raw);
    t[t.length - 40] = t[t.length - 40]! ^ 0xff;
    const bad = join(tmp, 'tampered.sssbk');
    writeFileSync(bad, t);
    expect(() => svc.read(bad)).toThrow(/decryption failed/);
    await svc.create();
    await svc.create();
    expect(svc.list()).toHaveLength(2);
    await h.db.$executeRawUnsafe('DROP DATABASE IF EXISTS "restore_check_1" WITH (FORCE)');
  });

  it('a passphrase-encrypted backup needs the passphrase', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sss-backup-test-'));
    h = await createHarness(ROUTES, { BACKUP_DIR: join(tmp, 'b'), BACKUP_KEY_FILE: join(tmp, 'k', 'backup.key'), BACKUP_PASSPHRASE: 'correct horse battery staple' });
    const b = await new BackupService(h.runtime.ctx).create();
    const noPass = new BackupService({ ...h.runtime.ctx, config: { ...h.runtime.ctx.config, BACKUP_PASSPHRASE: undefined } });
    expect(() => noPass.read(b.file)).toThrow(/BACKUP_PASSPHRASE/);
    const wrong = new BackupService({ ...h.runtime.ctx, config: { ...h.runtime.ctx.config, BACKUP_PASSPHRASE: 'wrong passphrase here' } });
    expect(() => wrong.read(b.file)).toThrow(/decryption failed/);
    expect(new BackupService(h.runtime.ctx).read(b.file).manifest.format).toBe('sss-backup/v1');
  });
});
