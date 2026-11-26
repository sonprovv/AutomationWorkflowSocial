/**
 * Social profile links found on a developer's own website (App Spy evidence chain:
 * store listing → developer website listed by the store → profile link published on that website).
 * Only explicit profile URLs count. Names are never matched.
 */

export type SocialPlatform = 'bluesky' | 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'x' | 'threads' | 'linkedin' | 'reddit' | 'pinterest';

export interface SocialLink {
  platform: SocialPlatform;
  /** Lower-cased handle, channel id, page name or community, as it appears in the URL. */
  handle: string;
  /** Canonical profile URL rebuilt from platform + handle. */
  profileUrl: string;
  /** The href exactly as found (resolved against the page URL). */
  href: string;
}

const RESERVED: Record<string, Set<string>> = {
  instagram: new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct', 'about', 'developer', 'legal', 'tv']),
  facebook: new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'policies', 'help', 'events', 'groups', 'watch', 'pages', 'profile.php', 'privacy', 'ads', 'business', 'l.php']),
  x: new Set(['intent', 'share', 'home', 'i', 'search', 'hashtag', 'login', 'signup', 'explore', 'settings', 'privacy', 'tos', 'messages', 'notifications']),
  pinterest: new Set(['pin', 'search', 'ideas', 'business', 'login', 'about', '_']),
  tiktok: new Set(['tag', 'music', 'discover', 'login', 'legal']),
};

/** Handles may carry a kind prefix (`company:acme`, `r:sub`). */
const HANDLE = /^[a-z0-9._:-]{1,100}$/;

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

/** Classify one URL as a social profile, or null (posts, share buttons, hashtags, … are not profiles). */
export function classifySocialUrl(raw: string): SocialLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = hostOf(url);
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const first = parts[0]?.toLowerCase() ?? '';
  const mk = (platform: SocialPlatform, handle: string, profileUrl: string): SocialLink | null => {
    const h = handle.toLowerCase();
    if (!HANDLE.test(h) || RESERVED[platform]?.has(h)) return null;
    return { platform, handle: h, profileUrl, href: url.toString() };
  };

  switch (host) {
    case 'bsky.app':
      return first === 'profile' && parts[1] ? mk('bluesky', parts[1].replace(/^@/, ''), `https://bsky.app/profile/${parts[1].replace(/^@/, '').toLowerCase()}`) : null;
    case 'youtube.com':
      if (first.startsWith('@')) return mk('youtube', first.slice(1), `https://www.youtube.com/@${first.slice(1)}`);
      if (first === 'channel' && parts[1]) return /^UC[A-Za-z0-9_-]{22}$/.test(parts[1]) ? { platform: 'youtube', handle: parts[1], profileUrl: `https://www.youtube.com/channel/${parts[1]}`, href: url.toString() } : null;
      if ((first === 'c' || first === 'user') && parts[1]) return mk('youtube', parts[1], `https://www.youtube.com/${first}/${parts[1].toLowerCase()}`);
      return null;
    case 'tiktok.com':
      return first.startsWith('@') ? mk('tiktok', first.slice(1), `https://www.tiktok.com/@${first.slice(1)}`) : null;
    case 'instagram.com':
      return parts.length >= 1 ? mk('instagram', first, `https://www.instagram.com/${first}`) : null;
    case 'facebook.com':
    case 'fb.com':
      return parts.length >= 1 ? mk('facebook', first, `https://www.facebook.com/${first}`) : null;
    case 'x.com':
    case 'twitter.com':
      return parts.length >= 1 ? mk('x', first.replace(/^@/, ''), `https://x.com/${first.replace(/^@/, '')}`) : null;
    case 'threads.net':
    case 'threads.com':
      return first.startsWith('@') ? mk('threads', first.slice(1), `https://www.threads.net/@${first.slice(1)}`) : null;
    case 'linkedin.com':
      return (first === 'company' || first === 'in' || first === 'school') && parts[1] ? mk('linkedin', `${first}:${parts[1]}`, `https://www.linkedin.com/${first}/${parts[1].toLowerCase()}`) : null;
    case 'reddit.com':
      if ((first === 'r' || first === 'user' || first === 'u') && parts[1]) {
        const kind = first === 'r' ? 'r' : 'u';
        return mk('reddit', `${kind}:${parts[1]}`, `https://www.reddit.com/${kind === 'r' ? 'r' : 'user'}/${parts[1].toLowerCase()}`);
      }
      return null;
    case 'pinterest.com':
      return parts.length === 1 ? mk('pinterest', first, `https://www.pinterest.com/${first}`) : null;
    default:
      return null;
  }
}

/** All distinct social profile links in an HTML document (href attributes only; scripts and text are ignored). */
export function extractSocialLinks(html: string, pageUrl: string): SocialLink[] {
  const out = new Map<string, SocialLink>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html)) && n < 5000) {
    n++;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!raw) continue;
    let abs: string;
    try {
      abs = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    const link = classifySocialUrl(abs);
    if (link && !out.has(`${link.platform}:${link.handle}`)) out.set(`${link.platform}:${link.handle}`, link);
  }
  return [...out.values()];
}

/** Registrable-domain approximation (last two labels, or three for common second-level suffixes such as co.uk, com.vn). */
export function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');
  const twoLevel = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  return labels.slice(twoLevel ? -3 : -2).join('.');
}
