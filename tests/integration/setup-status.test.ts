/** Setup guide status: reflects configuration and data as booleans/counts, and never leaks a secret value. */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { createHarness, type Harness } from './helpers.ts';

let h: Harness;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await h?.close();
});
const json = <T = any>(r: { body: string }) => JSON.parse(r.body) as T;

describe('GET /setup/status', () => {
  it('starts empty, reports configured keys as booleans only, and counts the first project', async () => {
    const secrets = { YOUTUBE_API_KEY: 'AIzaSyFAKE-youtube-key-000000000000', ANTHROPIC_API_KEY: 'sk-ant-FAKE-anthropic-0000000000', TELEGRAM_BOT_TOKEN: '123456:FAKE-telegram-token', TELEGRAM_CHAT_ID: '987654321', BACKUP_PASSPHRASE: 'fake-backup-passphrase-xyz' };
    h = await createHarness({}, secrets);
    app = await buildServer({ runtime: h.runtime });

    const r = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(r.statusCode).toBe(200);
    const s = json(r);
    expect(s).toMatchObject({
      app: { database: true, queueDriver: 'inline' },
      sources: { youtube: { apiKeySet: true }, bluesky: { appPasswordSet: false, policyProposal: 'PENDING_PRODUCT_OWNER_APPROVAL' }, appleAppStore: { policyProposal: 'PENDING_PRODUCT_OWNER_APPROVAL' } },
      features: { ai: { anthropicKeySet: true }, notifications: { telegram: true, email: false, webhook: false }, backup: { passphraseSet: true }, remoteAccess: { loopbackOnly: true, apiTokenSet: false } },
      data: { projects: 0, trackedAccounts: 0 },
    });
    for (const v of Object.values(secrets)) expect(r.body).not.toContain(v);

    await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'First', platforms: ['bluesky'] } });
    expect(json(await app.inject({ method: 'GET', url: '/api/v1/setup/status' })).data.projects).toBe(1);
  });
});
