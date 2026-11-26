import { z } from 'zod';
import { CollectorError } from './errors.ts';
import type { Provenance } from './types.ts';

/**
 * Validate a provider response against the minimal schema the adapter relies on.
 * Unknown extra fields are allowed (providers add fields); missing/renamed REQUIRED fields
 * raise SCHEMA_CHANGED so we never silently store garbage.
 */
export function parseResponse<S extends z.ZodType>(schema: S, data: unknown, source: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new CollectorError('SCHEMA_CHANGED', `Response from ${source} failed schema validation`, {
      details: { issues },
    });
  }
  return r.data;
}

export const searchInputSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(500),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).nullish(),
  language: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).optional(),
  region: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
});

export const listInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).nullish(),
});

/** Validate caller input; throws INVALID_INPUT with readable issues. */
export function validateInput<S extends z.ZodType>(schema: S, input: unknown, method: string): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new CollectorError('INVALID_INPUT', `${method}: ${issues}`);
  }
  return r.data;
}

/** Extract #hashtags from free text (unicode-aware, de-duplicated, lowercase). */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_/&#?=.])#([\p{L}\p{N}_]{1,100})/gu)) {
    if (m[1] && !/^\d+$/.test(m[1])) out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Parse a count that must be a non-negative integer; anything else becomes null (never 0). */
export function toCount(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function makeProvenance(p: Omit<Provenance, 'collectedAt'> & { collectedAt?: string }): Provenance {
  return { ...p, collectedAt: p.collectedAt ?? new Date().toISOString() };
}

/** ISO-8601 duration (YouTube contentDetails.duration, e.g. PT1M5S) to seconds. */
export function isoDurationToSeconds(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m) return null;
  const [, days, h, min, s] = m;
  return Number(days ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0));
}
