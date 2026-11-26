import { CollectorError, type Platform, type PlatformAdapter, type RequestLogEntry, type UsageMeter } from '@sss/collector-core';
import { BlueskyAdapter } from '@sss/collector-bluesky';
import { YouTubeAdapter } from '@sss/collector-youtube';
import type { AppConfig } from '@sss/config';

/**
 * Provider registry: the ONLY place that knows how to construct adapters.
 * Business logic asks for an adapter by providerId and never imports platform packages directly.
 */

export interface ProviderDescriptor {
  providerId: string;
  platform: Platform;
  /** Env var holding the credential (reference only — never the value). */
  credentialRef: string | null;
  credentialRequired: boolean;
  /** Unit charged against the provider daily cap. */
  usageUnit: 'requests' | 'quota_units';
  dailyCap(config: AppConfig): number;
  create(deps: AdapterDeps): PlatformAdapter;
}

export interface AdapterDeps {
  config: AppConfig;
  meter: UsageMeter;
  onLog?: (e: RequestLogEntry) => void;
}

const PROVIDERS: ProviderDescriptor[] = [
  {
    providerId: 'bluesky-appview',
    platform: 'bluesky',
    credentialRef: 'BLUESKY_APP_PASSWORD',
    credentialRequired: false,
    usageUnit: 'requests',
    dailyCap: (c) => c.BLUESKY_DAILY_REQUESTS,
    create: ({ config, meter, onLog }) =>
      new BlueskyAdapter({ meter, onLog, identifier: config.BLUESKY_IDENTIFIER, appPassword: config.BLUESKY_APP_PASSWORD }),
  },
  {
    providerId: 'youtube-data-api-v3',
    platform: 'youtube',
    credentialRef: 'YOUTUBE_API_KEY',
    credentialRequired: true,
    usageUnit: 'quota_units',
    dailyCap: (c) => c.YOUTUBE_DAILY_QUOTA_UNITS,
    create: ({ config, meter, onLog }) => new YouTubeAdapter({ apiKey: config.YOUTUBE_API_KEY, meter, onLog }),
  },
];

export const IMPLEMENTED_PROVIDER_IDS = PROVIDERS.map((p) => p.providerId);

export function getProviderDescriptor(providerId: string): ProviderDescriptor {
  const d = PROVIDERS.find((p) => p.providerId === providerId);
  if (!d) throw new CollectorError('NOT_SUPPORTED', `No adapter implemented for provider ${providerId}`);
  return d;
}

/** Implemented provider for a platform, or null (platform documented as BLOCKED/AUTH_REQUIRED etc.). */
export function providerForPlatform(platform: Platform): ProviderDescriptor | null {
  return PROVIDERS.find((p) => p.platform === platform) ?? null;
}

export function credentialRefs(): Record<string, string> {
  return Object.fromEntries(PROVIDERS.filter((p) => p.credentialRef).map((p) => [p.platform, p.credentialRef!]));
}

/**
 * Test hook: register a descriptor that takes precedence over the built-in one for the same
 * providerId/platform (e.g. a real adapter pointed at a local fake server). Returns an unregister fn.
 */
export function registerProviderForTests(d: ProviderDescriptor): () => void {
  PROVIDERS.unshift(d);
  return () => {
    const i = PROVIDERS.indexOf(d);
    if (i >= 0) PROVIDERS.splice(i, 1);
  };
}
