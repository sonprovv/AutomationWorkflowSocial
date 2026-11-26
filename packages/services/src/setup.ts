import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@sss/config';
import { BackupService } from './backup.ts';
import type { ServiceContext } from './context.ts';
import { SchedulerService } from './scheduler.ts';

/**
 * Setup guide status (UI dialog): facts about this installation as booleans and counts. It NEVER returns a
 * secret, a secret's length or a prefix — only whether a setting is present.
 */
export class SetupService {
  constructor(private readonly ctx: ServiceContext) {}

  private proposal(rel: string): string | null {
    try {
      const r = JSON.parse(readFileSync(join(findRepoRoot(), rel), 'utf8')) as { policyProposal?: { status?: string } };
      return r.policyProposal?.status ?? null;
    } catch {
      return null;
    }
  }

  async status() {
    const { db, config: c, dispatcher } = this.ctx;
    const backup = new BackupService(this.ctx);
    let backups = 0;
    try {
      backups = backup.list().length;
    } catch {
      backups = 0;
    }
    const [projects, tracked, keywords, posts, apps, workflows, providers, paused] = await Promise.all([
      db.project.count({ where: { status: 'ACTIVE' } }),
      db.projectAccount.count({ where: { trackingStatus: 'TRACKING' } }),
      db.keyword.count({ where: { status: 'ACTIVE' } }),
      db.post.count(),
      db.app.count(),
      db.workflowDef.count({ where: { status: { not: 'ARCHIVED' } } }),
      db.provider.findMany({ where: { id: { in: ['bluesky-appview', 'youtube-data-api-v3'] } }, select: { id: true, enabled: true, status: true } }),
      new SchedulerService(this.ctx).isPaused(),
    ]);
    const prov = (id: string) => providers.find((p) => p.id === id) ?? null;
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(c.API_HOST);
    return {
      checkedAt: new Date().toISOString(),
      app: { database: true, queueDriver: dispatcher.driver, schedulerPaused: paused },
      sources: {
        bluesky: { enabled: prov('bluesky-appview')?.enabled ?? false, status: prov('bluesky-appview')?.status ?? null, appPasswordSet: Boolean(c.BLUESKY_IDENTIFIER && c.BLUESKY_APP_PASSWORD), policyProposal: this.proposal('docs/feasibility/capabilities/bluesky.json') },
        youtube: { enabled: prov('youtube-data-api-v3')?.enabled ?? false, status: prov('youtube-data-api-v3')?.status ?? null, apiKeySet: Boolean(c.YOUTUBE_API_KEY) },
        appleAppStore: { policyProposal: this.proposal('docs/feasibility/app-stores/apple.json') },
      },
      features: {
        ai: { anthropicKeySet: Boolean(c.ANTHROPIC_API_KEY) },
        notifications: { telegram: Boolean(c.TELEGRAM_BOT_TOKEN && c.TELEGRAM_CHAT_ID), email: Boolean(c.SMTP_URL && c.EMAIL_FROM && c.EMAIL_TO), webhook: Boolean(c.WEBHOOK_URL) },
        backup: { passphraseSet: Boolean(c.BACKUP_PASSPHRASE), keyFileExists: existsSync(backup.keyFile()), backups },
        remoteAccess: { loopbackOnly: loopback, apiTokenSet: Boolean(c.API_TOKEN) },
      },
      data: { projects, trackedAccounts: tracked, activeKeywords: keywords, posts, apps, workflows },
    };
  }
}
