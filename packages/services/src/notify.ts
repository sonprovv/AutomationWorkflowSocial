import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { redactDeep } from '@sss/collector-core';
import { nowOf, type ServiceContext } from './context.ts';

export type Channel = 'telegram' | 'email' | 'webhook';

export interface Message {
  projectId: string | null;
  type: 'report' | 'viral_alert' | 'job_failed' | 'test';
  /** Idempotency per channel: the same key is delivered at most once (bounded retries if it failed). */
  dedupKey: string;
  title: string;
  /** Plain text summary with links. Never secrets, never data a policy does not allow to leave the app. */
  body: string;
  /** Structured payload for the webhook. */
  data?: Record<string, unknown>;
}

const MAX_ATTEMPTS = 3;
const TELEGRAM_LIMIT = 4000;

/**
 * Notification delivery (Master Plan §7.8, §12): Telegram Bot API, SMTP email, signed webhook.
 * - Channels are off until configured; an unconfigured channel is SKIPPED (recorded), not an error.
 * - Dedup by (channel, dedupKey): a delivered message is never sent twice; a failed one is retried at most
 *   MAX_ATTEMPTS times across calls, with a short backoff inside one call.
 * - Webhook body is signed: `X-SSS-Signature: sha256=<hex HMAC(secret, timestamp + "." + body)>`,
 *   `X-SSS-Timestamp: <unix seconds>`; receivers should reject old timestamps.
 */
export class NotificationService {
  constructor(private readonly ctx: ServiceContext) {}

  configured(): Channel[] {
    const c = this.ctx.config;
    const out: Channel[] = [];
    if (c.TELEGRAM_BOT_TOKEN && c.TELEGRAM_CHAT_ID) out.push('telegram');
    if (c.SMTP_URL && c.EMAIL_FROM && c.EMAIL_TO) out.push('email');
    if (c.WEBHOOK_URL) out.push('webhook');
    return out;
  }

  async send(m: Message, channels: Channel[] = ['telegram', 'email', 'webhook']): Promise<{ channel: Channel; status: string; error?: string }[]> {
    const { db } = this.ctx;
    const enabled = new Set(this.configured());
    const results: { channel: Channel; status: string; error?: string }[] = [];
    for (const channel of channels) {
      const existing = await db.notification.findUnique({ where: { channel_dedupKey: { channel, dedupKey: m.dedupKey } } });
      if (existing && (existing.status === 'SENT' || existing.status === 'SKIPPED' || existing.attempts >= MAX_ATTEMPTS)) {
        results.push({ channel, status: existing.status === 'SENT' ? 'DUPLICATE' : existing.status });
        continue;
      }
      const row =
        existing ??
        (await db.notification.create({ data: { projectId: m.projectId, channel, type: m.type, dedupKey: m.dedupKey, status: 'PENDING', title: m.title.slice(0, 300), body: m.body.slice(0, 20_000) } }));
      if (!enabled.has(channel)) {
        await db.notification.update({ where: { id: row.id }, data: { status: 'SKIPPED', error: 'Channel not configured' } });
        results.push({ channel, status: 'SKIPPED' });
        continue;
      }
      let error: string | null = null;
      for (let attempt = row.attempts + 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await this.deliver(channel, m);
          error = null;
          await db.notification.update({ where: { id: row.id }, data: { status: 'SENT', attempts: attempt, sentAt: nowOf(this.ctx), error: null } });
          break;
        } catch (e) {
          error = redactDeep(String((e as Error).message)).slice(0, 500);
          await db.notification.update({ where: { id: row.id }, data: { status: 'FAILED', attempts: attempt, error } });
          if ((e as { permanent?: boolean }).permanent) break;
          if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
      results.push({ channel, status: error ? 'FAILED' : 'SENT', ...(error ? { error } : {}) });
    }
    return results;
  }

  private async deliver(channel: Channel, m: Message): Promise<void> {
    const c = this.ctx.config;
    if (channel === 'telegram') {
      const text = `${m.title}\n\n${m.body}`;
      const res = await fetch(`${c.TELEGRAM_API_BASE}/bot${c.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c.TELEGRAM_CHAT_ID, text: text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 1)}…` : text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const err = new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`) as Error & { permanent?: boolean };
        err.permanent = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
        throw err;
      }
      return;
    }
    if (channel === 'email') {
      const transport = nodemailer.createTransport(c.SMTP_URL!);
      await transport.sendMail({ from: c.EMAIL_FROM, to: c.EMAIL_TO, subject: m.title, text: m.body });
      return;
    }
    const body = JSON.stringify({ type: m.type, title: m.title, body: m.body, projectId: m.projectId, dedupKey: m.dedupKey, data: m.data ?? {} });
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-sss-timestamp': ts, 'x-sss-event': m.type, 'x-sss-delivery': m.dedupKey };
    if (c.WEBHOOK_SECRET) headers['x-sss-signature'] = `sha256=${signWebhook(c.WEBHOOK_SECRET, ts, body)}`;
    const res = await fetch(c.WEBHOOK_URL!, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!res.ok) {
      const err = new Error(`Webhook HTTP ${res.status}`) as Error & { permanent?: boolean };
      err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }
  }

  async list(limit = 50) {
    const rows = await this.ctx.db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, channel: r.channel, type: r.type, status: r.status, attempts: r.attempts, title: r.title, error: r.error, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null }));
  }
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
