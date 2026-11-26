/**
 * Rule-based candidate relevance (Master Plan §7.3 step 6) — version `rule-v1`.
 *
 * Score 0–100 from observable evidence only (no AI, no inferred demographics/market):
 *   keyword in handle/display name ........ up to 30
 *   keyword in bio ......................... up to 20
 *   own posts matching keywords ............ up to 30 (10 per matching post)
 *   account-search rank .................... up to 15 (best rank across keywords)
 *   matched by ≥ 2 distinct keywords ....... +5
 * Classification is a heuristic guess with confidence "low"; a person reviews every candidate.
 */
import { normalizeKeyword } from './keywords.ts';

export const SCORE_VERSION = 'rule-v1';

export type Classification = 'DIRECT_COMPETITOR' | 'ADJACENT_COMPETITOR' | 'CREATOR' | 'PUBLISHER' | 'IRRELEVANT' | 'UNKNOWN';

export interface CandidateSignals {
  username: string | null;
  displayName: string | null;
  bio: string | null;
  /** Keywords (normalized) whose account search returned this account, with the best rank (1-based) and page size. */
  accountHits: { keyword: string; rank: number; of: number }[];
  /** Keywords (normalized) whose post search returned posts BY this account. */
  postHits: { keyword: string; url: string }[];
  /** All keywords (normalized) of the run, for text matching. */
  keywords: string[];
}

export interface ScoredCandidate {
  score: number;
  classification: Classification;
  confidence: 'low';
  reasons: string[];
  matchedKeywords: string[];
  scoreVersion: string;
}

const PUBLISHER = /\b(news|magazine|media|journal|times|daily|press|tv|radio|official news|newsletter|báo|tin tức)\b/iu;
const CREATOR = /\b(creator|artist|designer|photographer|youtuber|streamer|influencer|blogger|illustrator)\b/iu;
const BRAND = /\b(app|apps|studio|inc|llc|ltd|official|store|shop|company|co\.|team|labs?)\b/iu;

/** Text match on word-ish boundaries; also matches the compact form ("livewallpaper") inside handles. */
export function textMatches(text: string | null, keyword: string): boolean {
  if (!text) return false;
  const t = normalizeKeyword(text);
  const k = normalizeKeyword(keyword);
  if (!k) return false;
  if (t.includes(k)) return true;
  const compactK = k.replace(/ /g, '');
  return compactK.length >= 4 && t.replace(/[\s._-]/g, '').includes(compactK);
}

export function scoreCandidate(s: CandidateSignals): ScoredCandidate {
  const reasons: string[] = [];
  const matched = new Set<string>();
  let score = 0;

  const nameHits = s.keywords.filter((k) => textMatches(s.username, k) || textMatches(s.displayName, k));
  if (nameHits.length) {
    score += Math.min(30, 20 + 5 * (nameHits.length - 1));
    reasons.push(`Keyword in handle/name: ${nameHits.join(', ')}`);
    nameHits.forEach((k) => matched.add(k));
  }
  const bioHits = s.keywords.filter((k) => textMatches(s.bio, k));
  if (bioHits.length) {
    score += Math.min(20, 12 + 4 * (bioHits.length - 1));
    reasons.push(`Keyword in bio: ${bioHits.join(', ')}`);
    bioHits.forEach((k) => matched.add(k));
  }
  const postUrls = new Set(s.postHits.map((p) => p.url));
  if (postUrls.size) {
    score += Math.min(30, 10 * postUrls.size);
    reasons.push(`${postUrls.size} own post(s) matched keyword search`);
    s.postHits.forEach((p) => matched.add(p.keyword));
  }
  if (s.accountHits.length) {
    const best = s.accountHits.reduce((a, b) => (a.rank / a.of <= b.rank / b.of ? a : b));
    score += Math.round(15 * (1 - (best.rank - 1) / Math.max(best.of, 1)));
    reasons.push(`Account search rank ${best.rank}/${best.of} for "${best.keyword}"`);
    s.accountHits.forEach((h) => matched.add(h.keyword));
  }
  if (matched.size >= 2) {
    score += 5;
    reasons.push(`Matched ${matched.size} distinct keywords`);
  }
  score = Math.max(0, Math.min(100, score));

  const profileText = `${s.displayName ?? ''} ${s.username ?? ''} ${s.bio ?? ''}`;
  let classification: Classification;
  if (score < 20) classification = 'IRRELEVANT';
  else if (PUBLISHER.test(profileText)) classification = 'PUBLISHER';
  else if (CREATOR.test(profileText)) classification = 'CREATOR';
  else if (nameHits.length && BRAND.test(profileText)) classification = 'DIRECT_COMPETITOR';
  else if (nameHits.length || bioHits.length) classification = 'ADJACENT_COMPETITOR';
  else classification = 'UNKNOWN';

  return { score, classification, confidence: 'low', reasons, matchedKeywords: [...matched], scoreVersion: SCORE_VERSION };
}
