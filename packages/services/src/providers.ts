import { toCollectorError } from '@sss/collector-core';
import type { Prisma } from '@sss/database';
import { getProviderDescriptor, IMPLEMENTED_PROVIDER_IDS } from '@sss/collector-registry';
import { getEffectivePolicy } from '@sss/policy-engine';
import { AppError } from '@sss/shared';
import { nowOf, type ServiceContext } from './context.ts';
import { iso } from './serialize.ts';
import { UsageGuard } from './usage.ts';

export class ProviderService {
  private readonly usage: UsageGuard;
  constructor(private readonly ctx: ServiceContext) {
    this.usage = new UsageGuard(ctx);
  }

  async list() {
    const rows = await this.ctx.db.provider.findMany({ orderBy: [{ enabled: 'desc' }, { platform: 'asc' }] });
    return Promise.all(
      rows.map(async (p) => {
        const implemented = IMPLEMENTED_PROVIDER_IDS.includes(p.id);
        const policy = await getEffectivePolicy(this.ctx.db, p.id);
        let usageToday: Record<string, number> | null = null;
        let credentialConfigured: boolean | null = null;
        if (implemented) {
          const d = getProviderDescriptor(p.id);
          usageToday = { [d.usageUnit]: await this.usage.usedToday(p.id, d.usageUnit), dailyCap: d.dailyCap(this.ctx.config) };
          credentialConfigured = d.credentialRef ? Boolean((this.ctx.config as Record<string, unknown>)[d.credentialRef]) : null;
        }
        return {
          id: p.id,
          platform: p.platform,
          status: p.status,
          enabled: p.enabled,
          implemented,
          credentialRef: p.credentialRef,
          credentialConfigured,
          capabilities: p.capabilities,
          policy,
          usageToday,
          lastHealth: p.lastHealth,
          checkedAt: iso(p.checkedAt),
        };
      }),
    );
  }

  /** Credential + health check with the real provider (cheap calls; counted against the daily cap). */
  async test(providerId: string) {
    const p = await this.ctx.db.provider.findUnique({ where: { id: providerId } });
    if (!p) throw new AppError('NOT_FOUND', `Provider ${providerId} not found`);
    if (!IMPLEMENTED_PROVIDER_IDS.includes(providerId)) {
      throw new AppError('NOT_SUPPORTED', `No adapter implemented for ${providerId} (status ${p.status})`);
    }
    const d = getProviderDescriptor(providerId);
    const meter = await this.usage.meterFor(providerId, 5);
    const adapter = d.create({ config: this.ctx.config, meter });
    let result: { healthy: boolean } & Record<string, unknown>;
    try {
      const credentials = await adapter.validateCredentials();
      const health = credentials.state === 'MISSING' ? null : await adapter.healthCheck();
      result = { credentials, health, healthy: health?.healthy ?? false };
    } catch (e) {
      const ce = toCollectorError(e);
      result = { healthy: false, error: { code: ce.code, message: ce.message } };
    } finally {
      await this.usage.record(providerId, meter.snapshot(), {}, meter);
    }
    await this.ctx.db.provider.update({
      where: { id: providerId },
      data: { lastHealth: result as Prisma.InputJsonValue, checkedAt: nowOf(this.ctx) },
    });
    return { providerId, checkedAt: nowOf(this.ctx).toISOString(), ...result };
  }

  async testAllEnabled() {
    const rows = await this.ctx.db.provider.findMany({ where: { enabled: true } });
    const out = [];
    for (const r of rows) out.push(await this.test(r.id));
    return out;
  }
}
