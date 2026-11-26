import { describe, expect, it } from 'vitest';
import { normalizeKeyword, ruleVariants } from '../src/keywords.ts';
import { scoreCandidate, textMatches } from '../src/scoring.ts';

describe('normalizeKeyword', () => {
  it('folds case/width, strips leading #, collapses spaces', () => {
    expect(normalizeKeyword('  #Live   Wallpaper ')).toBe('live wallpaper');
    expect(normalizeKeyword('ＬＩＶＥ')).toBe('live'); // NFKC full-width
    expect(normalizeKeyword('Hình Nền Động')).toBe('hình nền động');
  });
});

describe('ruleVariants (WF01 rule mode)', () => {
  it('adds the compact form and the English singular/plural of the last word', () => {
    expect(ruleVariants('live wallpaper', 'en').sort()).toEqual(['live wallpapers', 'livewallpaper']);
    expect(ruleVariants('wallpapers', 'en')).toEqual(['wallpaper']);
    expect(ruleVariants('workout challenges', null).sort()).toEqual(['workout challenge', 'workoutchallenges']);
    expect(ruleVariants('story', 'en')).toEqual(['stories']);
    expect(ruleVariants('stories', 'en')).toEqual(['story']);
  });
  it('does not apply English plural rules to other languages', () => {
    expect(ruleVariants('hình nền', 'vi')).toEqual(['hìnhnền']);
  });
});

describe('scoreCandidate (rule-v1)', () => {
  const base = { username: null, displayName: null, bio: null, accountHits: [], postHits: [], keywords: ['live wallpaper', 'depth wallpaper'] };

  it('matches compact forms inside handles', () => {
    expect(textMatches('livewallpaper.bsky.social', 'live wallpaper')).toBe(true);
    expect(textMatches('Live-Wallpaper Studio', 'live wallpaper')).toBe(true);
    expect(textMatches('wallpaper fan', 'live wallpaper')).toBe(false);
  });

  it('scores strong evidence high, with reasons, and caps at 100', () => {
    const s = scoreCandidate({
      ...base,
      username: 'livewallpaper.app',
      displayName: 'Live Wallpaper App',
      bio: 'Depth wallpaper and live wallpaper studio',
      accountHits: [{ keyword: 'live wallpaper', rank: 1, of: 25 }],
      postHits: [1, 2, 3, 4].map((i) => ({ keyword: 'depth wallpaper', url: `https://x/${i}` })),
    });
    // name 20 (1 keyword) + bio 16 (2 keywords) + posts 30 (cap) + rank 15 + multi-keyword 5
    expect(s.score).toBe(86);
    const maxed = scoreCandidate({ ...base, username: 'livewallpaper', displayName: 'Depth Wallpaper', bio: 'live wallpaper, depth wallpaper', accountHits: [{ keyword: 'live wallpaper', rank: 1, of: 1 }], postHits: [1, 2, 3].map((i) => ({ keyword: 'live wallpaper', url: `u${i}` })) });
    expect(maxed.score).toBe(91); // name 25 + bio 16 + posts 30 + rank 15 + multi 5
    expect(maxed.score).toBeLessThanOrEqual(100);
    expect(s.classification).toBe('DIRECT_COMPETITOR');
    expect(s.confidence).toBe('low');
    expect(s.matchedKeywords.sort()).toEqual(['depth wallpaper', 'live wallpaper']);
    expect(s.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('a single matching post from an unrelated profile stays low; no evidence → IRRELEVANT', () => {
    const one = scoreCandidate({ ...base, displayName: 'Jane', postHits: [{ keyword: 'live wallpaper', url: 'https://x/1' }] });
    expect(one.score).toBe(10);
    expect(one.classification).toBe('IRRELEVANT');
    expect(scoreCandidate(base)).toMatchObject({ score: 0, classification: 'IRRELEVANT' });
  });

  it('labels publishers and creators from their own profile text', () => {
    const pub = scoreCandidate({ ...base, displayName: 'Tech News Daily', bio: 'live wallpaper reviews', postHits: [{ keyword: 'live wallpaper', url: 'u1' }] });
    expect(pub.classification).toBe('PUBLISHER');
    const cr = scoreCandidate({ ...base, displayName: 'Ana', bio: 'Illustrator making live wallpaper art', postHits: [{ keyword: 'live wallpaper', url: 'u1' }] });
    expect(cr.classification).toBe('CREATOR');
  });

  it('lower search rank gives fewer points', () => {
    const top = scoreCandidate({ ...base, accountHits: [{ keyword: 'live wallpaper', rank: 1, of: 20 }] });
    const low = scoreCandidate({ ...base, accountHits: [{ keyword: 'live wallpaper', rank: 20, of: 20 }] });
    expect(top.score).toBeGreaterThan(low.score);
  });
});
