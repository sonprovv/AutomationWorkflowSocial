import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signWebhook } from '../src/notify.ts';

const require = createRequire(import.meta.url);
const tpl = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/integrations/n8n/${name}.json`, import.meta.url), 'utf8'));

describe('n8n templates', () => {
  it('are well-formed (every connection points at an existing node)', () => {
    for (const name of ['sss-daily-report', 'sss-webhook-receiver']) {
      const w = tpl(name);
      const names = new Set(w.nodes.map((n: { name: string }) => n.name));
      for (const [from, v] of Object.entries(w.connections as Record<string, { main: { node: string }[][] }>)) {
        expect(names.has(from)).toBe(true);
        for (const o of v.main.flat()) expect(names.has(o.node)).toBe(true);
      }
    }
  });

  it('the receiver Code node accepts our signature and rejects a forged or stale one', () => {
    const code = tpl('sss-webhook-receiver').nodes.find((n: { name: string }) => n.name === 'Verify signature').parameters.jsCode as string;
    const secret = 'webhook-secret-for-tests-0123456789';
    const run = (headers: Record<string, string>, raw: string) =>
      new Function('require', '$input', '$env', code)(require, { all: () => [{ json: { headers }, binary: { data: { data: Buffer.from(raw).toString('base64') } } }] }, { SSS_WEBHOOK_SECRET: secret })[0].json;
    const body = JSON.stringify({ type: 'report', title: 't' });
    const ts = String(Math.floor(Date.now() / 1000));
    const good = { 'x-sss-timestamp': ts, 'x-sss-signature': `sha256=${signWebhook(secret, ts, body)}`, 'x-sss-event': 'report' };
    expect(run(good, body)).toMatchObject({ valid: true, event: 'report', payload: { type: 'report' } });
    expect(run(good, body.replace('report', 'other')).valid).toBe(false);
    const old = String(Number(ts) - 3600);
    expect(run({ ...good, 'x-sss-timestamp': old, 'x-sss-signature': `sha256=${signWebhook(secret, old, body)}` }, body).valid).toBe(false);
  });
});
