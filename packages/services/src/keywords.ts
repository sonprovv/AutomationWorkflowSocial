import { z } from 'zod';
import type { Keyword, Prisma } from '@sss/database';
import { AppError } from '@sss/shared';
import type { ServiceContext } from './context.ts';
import { iso } from './serialize.ts';

/** Dedup key: NFKC, lower-case (locale-independent), collapsed spaces, no leading '#'. */
export function normalizeKeyword(text: string): string {
  return text.normalize('NFKC').trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const keywordInputSchema = z
  .object({
    text: z.string().trim().min(1).max(100),
    language: z.string().min(2).max(10).optional(),
    priority: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const addKeywordsSchema = z.object({ keywords: z.array(keywordInputSchema).min(1).max(100) }).strict();

export const keywordPatchSchema = z
  .object({ status: z.enum(['SUGGESTED', 'ACTIVE', 'PAUSED', 'REJECTED']).optional(), priority: z.number().int().min(0).max(100).optional() })
  .strict();

export function toKeywordView(k: Keyword) {
  return {
    id: k.id,
    projectId: k.projectId,
    text: k.text,
    normalizedText: k.normalizedText,
    language: k.language,
    origin: k.origin,
    status: k.status,
    priority: k.priority,
    parentId: k.parentId,
    createdAt: k.createdAt.toISOString(),
    updatedAt: iso(k.updatedAt),
  };
}
export type KeywordView = ReturnType<typeof toKeywordView>;

/**
 * Rule-based keyword expansion (WF01 without AI, Master Plan §7.3 step 1 "manual or rule-based mode"):
 * hashtag form, compact (no spaces) form, simple English singular/plural of the last word.
 * Every variant is derived from the user's own text; nothing is invented. AI expansion arrives in Phase 6.
 */
export function ruleVariants(text: string, language: string | null): string[] {
  const base = normalizeKeyword(text);
  const out = new Set<string>();
  const words = base.split(' ');
  if (words.length > 1) out.add(words.join('')); // "live wallpaper" → "livewallpaper" (hashtag-style search term)
  const english = !language || language.toLowerCase().startsWith('en');
  if (english && /^[a-z]+$/.test(words.at(-1) ?? '')) {
    const last = words.at(-1)!;
    let alt: string | null = null;
    if (last.endsWith('ies') && last.length > 4) alt = `${last.slice(0, -3)}y`;
    else if (/(s|x|z|ch|sh)es$/.test(last) && last.length > 4) alt = last.slice(0, -2);
    else if (last.endsWith('s') && !last.endsWith('ss') && last.length > 3) alt = last.slice(0, -1);
    else if (last.endsWith('y') && !/[aeiou]y$/.test(last)) alt = `${last.slice(0, -1)}ies`;
    else if (/(s|x|z|ch|sh)$/.test(last)) alt = `${last}es`;
    else alt = `${last}s`;
    if (alt && alt !== last) out.add([...words.slice(0, -1), alt].join(' '));
  }
  out.delete(base);
  return [...out];
}

export class KeywordService {
  constructor(private readonly ctx: ServiceContext) {}

  private async project(projectId: string) {
    const p = await this.ctx.db.project.findUnique({ where: { id: projectId } });
    if (!p) throw new AppError('NOT_FOUND', `Project ${projectId} not found`);
    return p;
  }

  async list(projectId: string, status?: Keyword['status']): Promise<KeywordView[]> {
    await this.project(projectId);
    const rows = await this.ctx.db.keyword.findMany({ where: { projectId, status }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 1000 });
    return rows.map(toKeywordView);
  }

  /** Add manual keywords. Duplicates (same normalized text) are returned as `existing`, not errors. */
  async add(projectId: string, input: unknown): Promise<{ created: KeywordView[]; existing: KeywordView[] }> {
    const v = addKeywordsSchema.parse(input);
    const p = await this.project(projectId);
    const created: KeywordView[] = [];
    const existing: KeywordView[] = [];
    for (const k of v.keywords) {
      const normalizedText = normalizeKeyword(k.text);
      if (!normalizedText) throw new AppError('INVALID_INPUT', `Keyword "${k.text}" is empty after normalization`);
      const found = await this.ctx.db.keyword.findUnique({ where: { projectId_normalizedText: { projectId, normalizedText } } });
      if (found) {
        // Adding a keyword the user previously only saw as a suggestion activates it.
        if (found.status === 'SUGGESTED') {
          const u = await this.ctx.db.keyword.update({ where: { id: found.id }, data: { status: 'ACTIVE', origin: 'MANUAL' } });
          created.push(toKeywordView(u));
        } else existing.push(toKeywordView(found));
        continue;
      }
      const row = await this.ctx.db.keyword.create({
        data: { projectId, text: k.text.trim(), normalizedText, language: k.language ?? p.languages[0] ?? null, priority: k.priority ?? 0, origin: 'MANUAL', status: 'ACTIVE' },
      });
      created.push(toKeywordView(row));
    }
    return { created, existing };
  }

  async update(id: string, input: unknown): Promise<KeywordView> {
    const v = keywordPatchSchema.parse(input);
    const k = await this.ctx.db.keyword.findUnique({ where: { id } });
    if (!k) throw new AppError('NOT_FOUND', `Keyword ${id} not found`);
    return toKeywordView(await this.ctx.db.keyword.update({ where: { id }, data: v as Prisma.KeywordUpdateInput }));
  }

  async delete(id: string): Promise<void> {
    const r = await this.ctx.db.keyword.deleteMany({ where: { id } });
    if (!r.count) throw new AppError('NOT_FOUND', `Keyword ${id} not found`);
  }

  /**
   * WF01 (rule mode): expand ACTIVE keywords into SUGGESTED variants, capped by `max_keywords_per_run`.
   * Suggestions are never searched until the user activates them.
   */
  async expand(projectId: string, maxNew: number): Promise<{ suggested: KeywordView[]; mode: 'rule'; notes: string[] }> {
    await this.project(projectId);
    const seeds = await this.ctx.db.keyword.findMany({ where: { projectId, status: 'ACTIVE' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    if (!seeds.length) throw new AppError('INVALID_INPUT', 'Add at least one ACTIVE keyword before expanding');
    const known = new Set((await this.ctx.db.keyword.findMany({ where: { projectId }, select: { normalizedText: true } })).map((k) => k.normalizedText));
    const suggested: KeywordView[] = [];
    for (const s of seeds) {
      for (const variant of ruleVariants(s.text, s.language)) {
        if (suggested.length >= maxNew) break;
        if (known.has(variant)) continue;
        known.add(variant);
        const row = await this.ctx.db.keyword.create({
          data: { projectId, text: variant, normalizedText: variant, language: s.language, origin: 'RULE', status: 'SUGGESTED', parentId: s.id, priority: Math.max(0, s.priority - 1) },
        });
        suggested.push(toKeywordView(row));
      }
    }
    return {
      suggested,
      mode: 'rule',
      notes: ['Rule-based expansion (hashtag/compact form, English singular/plural). AI expansion (synonyms, long-tail, problems, brands) arrives in Phase 6.'],
    };
  }
}
