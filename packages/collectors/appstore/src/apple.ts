import { z } from 'zod';
import { CollectorError, HttpClient, type RequestLogEntry, type UsageMeter } from '@sss/collector-core';

/**
 * Apple iTunes Search / Lookup API (public, official, no credential) — App Spy, Phase 9 (P9-03).
 * Docs: https://performance-partners.apple.com/search-api ("approximately 20 calls per minute").
 * The client paces itself process-wide (one call per `minIntervalMs`, default 3.1 s) so several jobs together
 * stay under the documented limit. It never downloads icons or screenshots (promo content may only promote the store).
 */

export const APPLE_PROVIDER_ID = 'apple-itunes-search';
export const APPLE_HOST = 'itunes.apple.com';

const softwareSchema = z.looseObject({
  wrapperType: z.literal('software'),
  kind: z.string().optional(),
  trackId: z.number().int(),
  trackName: z.string(),
  bundleId: z.string().optional(),
  artistId: z.number().int().optional(),
  artistName: z.string().optional(),
  sellerName: z.string().optional(),
  sellerUrl: z.string().optional(),
  artistViewUrl: z.string().optional(),
  trackViewUrl: z.string(),
  primaryGenreName: z.string().optional(),
  genres: z.array(z.string()).optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  formattedPrice: z.string().optional(),
  averageUserRating: z.number().optional(),
  userRatingCount: z.number().int().optional(),
  version: z.string().optional(),
  releaseDate: z.string().optional(),
  currentVersionReleaseDate: z.string().optional(),
  description: z.string().optional(),
  contentAdvisoryRating: z.string().optional(),
  languageCodesISO2A: z.array(z.string()).optional(),
  minimumOsVersion: z.string().optional(),
});
const artistSchema = z.looseObject({ wrapperType: z.literal('artist'), artistId: z.number().int(), artistName: z.string(), artistLinkUrl: z.string().optional(), artistType: z.string().optional() });
const responseSchema = z.object({ resultCount: z.number().int(), results: z.array(z.looseObject({ wrapperType: z.string().optional() })) });

export interface AppRecord {
  store: 'apple';
  storeAppId: string;
  country: string;
  bundleId: string | null;
  name: string;
  developerId: string | null;
  developerName: string | null;
  sellerName: string | null;
  /** Developer website as listed by the store (`sellerUrl`); null when the listing has none. */
  websiteUrl: string | null;
  storeUrl: string;
  developerUrl: string | null;
  genre: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  ratingCount: number | null;
  version: string | null;
  releasedAt: string | null;
  storeUpdatedAt: string | null;
  description: string | null;
  details: { genres: string[]; contentRating: string | null; languages: string[]; minimumOsVersion: string | null; kind: string | null; missing: Record<string, string> };
}

export interface DeveloperRecord {
  developerId: string;
  name: string;
  url: string | null;
}

/** Store links carry tracking parameters (`uo=4`); keep the canonical page only. */
export function cleanStoreUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function webUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeApp(raw: unknown, country: string): AppRecord {
  const r = softwareSchema.parse(raw);
  const missing: Record<string, string> = {};
  if (r.averageUserRating === undefined) missing.rating = 'NOT_PROVIDED';
  if (r.userRatingCount === undefined) missing.ratingCount = 'NOT_PROVIDED';
  const website = webUrl(r.sellerUrl);
  if (!website) missing.websiteUrl = 'NOT_LISTED_BY_DEVELOPER';
  return {
    store: 'apple',
    storeAppId: String(r.trackId),
    country: country.toLowerCase(),
    bundleId: r.bundleId ?? null,
    name: r.trackName,
    developerId: r.artistId !== undefined ? String(r.artistId) : null,
    developerName: r.artistName ?? null,
    sellerName: r.sellerName ?? null,
    websiteUrl: website,
    storeUrl: cleanStoreUrl(r.trackViewUrl) ?? r.trackViewUrl,
    developerUrl: cleanStoreUrl(r.artistViewUrl),
    genre: r.primaryGenreName ?? null,
    price: r.price ?? null,
    currency: r.currency ?? null,
    rating: r.averageUserRating ?? null,
    ratingCount: r.userRatingCount ?? null,
    version: r.version ?? null,
    releasedAt: r.releaseDate ?? null,
    storeUpdatedAt: r.currentVersionReleaseDate ?? null,
    description: r.description ? r.description.slice(0, 4000) : null,
    details: {
      genres: r.genres ?? [],
      contentRating: r.contentAdvisoryRating ?? null,
      languages: r.languageCodesISO2A ?? [],
      minimumOsVersion: r.minimumOsVersion ?? null,
      kind: r.kind ?? null,
      missing,
    },
  };
}

export type AppInput = { kind: 'id'; id: string; country?: string } | { kind: 'bundle'; bundleId: string };

/**
 * Accepts an App Store URL (`https://apps.apple.com/us/app/name/id123`), a numeric id or a bundle id.
 * Google Play URLs are refused with NOT_SUPPORTED: Google offers no official public catalogue API (ADR-0018).
 */
export function parseAppInput(input: string): AppInput {
  const s = input.trim();
  if (/^\d{5,12}$/.test(s)) return { kind: 'id', id: s };
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new CollectorError('INVALID_INPUT', 'Not a valid URL');
    }
    if (url.hostname === 'play.google.com') throw new CollectorError('NOT_SUPPORTED', 'Google Play has no official public catalogue API; App Spy supports the Apple App Store only (see docs/feasibility/google-play-apps.md)');
    if (url.hostname !== 'apps.apple.com' && url.hostname !== 'itunes.apple.com') throw new CollectorError('INVALID_INPUT', 'Expected an apps.apple.com link');
    const id = /\/id(\d{5,12})(?:$|[/?#])/.exec(url.pathname + '/')?.[1];
    if (!id) throw new CollectorError('INVALID_INPUT', 'No app id (…/id123456) in the link');
    const country = /^\/([a-z]{2})\//i.exec(url.pathname)?.[1]?.toLowerCase();
    return { kind: 'id', id, ...(country ? { country } : {}) };
  }
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s)) return { kind: 'bundle', bundleId: s };
  throw new CollectorError('INVALID_INPUT', 'Enter an App Store link, a numeric app id or a bundle id');
}

export interface AppleClientOptions {
  meter: UsageMeter;
  baseUrl?: string;
  allowedHosts?: string[];
  onLog?: (e: RequestLogEntry) => void;
  /** Minimum spacing between calls in this process (documented limit ≈ 20/min). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

// Process-wide pacing shared by every client instance.
let nextSlot = 0;
export function resetApplePacingForTests(): void {
  nextSlot = 0;
}

const COUNTRY = /^[a-z]{2}$/;

export class AppleAppStoreClient {
  private readonly http: HttpClient;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: AppleClientOptions) {
    this.minIntervalMs = o.minIntervalMs ?? 3100;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.http = new HttpClient({
      providerId: APPLE_PROVIDER_ID,
      baseUrl: o.baseUrl ?? `https://${APPLE_HOST}`,
      allowedHosts: o.allowedHosts ?? [APPLE_HOST],
      meter: o.meter,
      onLog: o.onLog,
      timeoutMs: 15_000,
      maxRetries: 2,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      classifyError: (res) => {
        if (res.status === 403 || res.status === 429) return new CollectorError('RATE_LIMITED', `Apple Search API refused the call (HTTP ${res.status}); it allows about 20 calls per minute`, { httpStatus: res.status, retryAfterMs: 60_000 });
        if (res.status >= 500) return new CollectorError('PROVIDER_UNAVAILABLE', `Apple Search API HTTP ${res.status}`, { httpStatus: res.status });
        return new CollectorError('INVALID_INPUT', `Apple Search API HTTP ${res.status}: ${res.text.slice(0, 200)}`, { httpStatus: res.status });
      },
    });
  }

  private async call(path: string, query: Record<string, string | number>) {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
    const res = await this.http.request<unknown>({ path, query });
    const parsed = responseSchema.safeParse(res.data);
    if (!parsed.success) throw new CollectorError('SCHEMA_CHANGED', 'Unexpected Apple Search API response shape');
    return parsed.data.results;
  }

  private country(c: string | undefined): string {
    const v = (c ?? 'us').toLowerCase();
    if (!COUNTRY.test(v)) throw new CollectorError('INVALID_INPUT', 'country must be a two-letter store code, e.g. us, vn');
    return v;
  }

  private apps(results: { wrapperType?: string }[], country: string): AppRecord[] {
    const out: AppRecord[] = [];
    for (const r of results) {
      if (r.wrapperType !== 'software') continue;
      try {
        out.push(normalizeApp(r, country));
      } catch {
        throw new CollectorError('SCHEMA_CHANGED', 'An app result is missing required fields (trackId, trackName, trackViewUrl)');
      }
    }
    return out;
  }

  async searchApps(term: string, opts: { country?: string; limit?: number } = {}): Promise<AppRecord[]> {
    const t = term.trim();
    if (!t || t.length > 100) throw new CollectorError('INVALID_INPUT', 'Search term must be 1–100 characters');
    const country = this.country(opts.country);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    return this.apps(await this.call('/search', { term: t, media: 'software', entity: 'software', country, limit }), country);
  }

  /** Lookup by App Store ids (up to 50 per call). Ids not in this storefront are simply absent. */
  async lookupApps(ids: string[], country?: string): Promise<AppRecord[]> {
    if (!ids.length) return [];
    if (ids.length > 50 || ids.some((i) => !/^\d{5,12}$/.test(i))) throw new CollectorError('INVALID_INPUT', 'Up to 50 numeric app ids');
    const c = this.country(country);
    return this.apps(await this.call('/lookup', { id: ids.join(','), country: c }), c);
  }

  /** Lookup by bundle id — works in practice but is not in Apple's documentation (PARTIAL). */
  async lookupBundle(bundleId: string, country?: string): Promise<AppRecord | null> {
    const c = this.country(country);
    return this.apps(await this.call('/lookup', { bundleId, country: c }), c)[0] ?? null;
  }

  /** A developer's apps: lookup of the developer (artist) id with entity=software. */
  async developerApps(developerId: string, opts: { country?: string; limit?: number } = {}): Promise<{ developer: DeveloperRecord | null; apps: AppRecord[] }> {
    if (!/^\d{5,12}$/.test(developerId)) throw new CollectorError('INVALID_INPUT', 'Developer id must be numeric');
    const c = this.country(opts.country);
    const results = await this.call('/lookup', { id: developerId, entity: 'software', country: c, limit: Math.min(Math.max(opts.limit ?? 50, 1), 200) });
    const a = results.map((r) => artistSchema.safeParse(r)).find((r) => r.success)?.data;
    return {
      developer: a ? { developerId: String(a.artistId), name: a.artistName, url: cleanStoreUrl(a.artistLinkUrl) } : null,
      apps: this.apps(results, c),
    };
  }
}
