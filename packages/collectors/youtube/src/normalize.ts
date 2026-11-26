import {
  CollectorError,
  extractHashtags,
  isoDurationToSeconds,
  makeProvenance,
  toCount,
  type Account,
  type ContentType,
  type Post,
  type PostMetrics,
  type Provenance,
} from '@sss/collector-core';
import type { ChannelResource, VideoResource } from './schemas.ts';

export const PROVIDER_ID = 'youtube-data-api-v3';
export const SCHEMA_VERSION = 'youtube-v3@2026-11-26';
/** Non-Authorized Data (channels we do not own): 30-day refresh-or-delete, no derived metrics by default. */
export const POLICY_ID = 'youtube-nonauthorized-v0';

export function provenance(source: string, collectedAt?: string): Provenance {
  return makeProvenance({ providerId: PROVIDER_ID, policyId: POLICY_ID, schemaVersion: SCHEMA_VERSION, source, collectedAt });
}

export type ChannelRef =
  | { kind: 'id'; value: string }
  | { kind: 'handle'; value: string }
  | { kind: 'username'; value: string }
  | { kind: 'custom'; value: string }
  | { kind: 'video'; value: string };

const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;
const VIDEO_ID_RE = /^[0-9A-Za-z_-]{11}$/;
const HANDLE_RE = /^@?[\p{L}\p{N}._-]{3,100}$/u;
/** First path segments that are YouTube pages, not channel vanity names. */
const RESERVED_PATHS = new Set(['results', 'watch', 'feed', 'playlist', 'embed', 'hashtag', 'shorts', 'live', 'channel', 'user', 'c', 'premium', 'gaming', 'account', 'about', 't', 'signin', 'logout', 'redirect', 'post', 'source']);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);

/**
 * Parse channel/video references:
 *  https://www.youtube.com/channel/UC…, /@handle, /user/name, /c/custom, /watch?v=…, /shorts/…, youtu.be/…,
 *  bare UC… ID, @handle.
 */
export function parseChannelInput(raw: string): ChannelRef {
  const s = raw.trim();
  if (!s) throw new CollectorError('INVALID_INPUT', 'Empty channel input');
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new CollectorError('INVALID_INPUT', `Invalid URL: ${s}`);
    }
    if (!YT_HOSTS.has(url.hostname)) throw new CollectorError('INVALID_INPUT', `Not a YouTube URL: ${url.hostname}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.hostname === 'youtu.be' && parts[0] && VIDEO_ID_RE.test(parts[0])) return { kind: 'video', value: parts[0] };
    const v = url.searchParams.get('v');
    if (parts[0] === 'watch' && v && VIDEO_ID_RE.test(v)) return { kind: 'video', value: v };
    if ((parts[0] === 'shorts' || parts[0] === 'live') && parts[1] && VIDEO_ID_RE.test(parts[1])) {
      return { kind: 'video', value: parts[1] };
    }
    if (parts[0] === 'channel' && parts[1] && CHANNEL_ID_RE.test(parts[1])) return { kind: 'id', value: parts[1] };
    if (parts[0]?.startsWith('@')) return { kind: 'handle', value: parts[0] };
    if (parts[0] === 'user' && parts[1]) return { kind: 'username', value: parts[1] };
    if (parts[0] === 'c' && parts[1]) return { kind: 'custom', value: parts[1] };
    if (parts.length === 1 && parts[0] && !RESERVED_PATHS.has(parts[0].toLowerCase()) && HANDLE_RE.test(parts[0])) return { kind: 'custom', value: parts[0] };
    throw new CollectorError('INVALID_INPUT', `Unrecognized YouTube URL: ${url.pathname}`);
  }
  if (CHANNEL_ID_RE.test(s)) return { kind: 'id', value: s };
  if (s.startsWith('@') && HANDLE_RE.test(s)) return { kind: 'handle', value: s };
  throw new CollectorError('INVALID_INPUT', `Not a YouTube channel URL, channel ID (UC…) or @handle: ${s}`);
}

function bestThumb(t: Record<string, { url: string }> | undefined): string | null {
  if (!t) return null;
  return (t['high'] ?? t['medium'] ?? t['standard'] ?? t['default'] ?? Object.values(t)[0])?.url ?? null;
}

export function normalizeChannel(c: ChannelResource, source: string, collectedAt: string): Account {
  const st = c.statistics;
  const hidden = st?.hiddenSubscriberCount === true;
  const handle = c.snippet?.customUrl ?? null;
  return {
    platform: 'youtube',
    externalId: c.id,
    username: handle,
    displayName: c.snippet?.title ?? null,
    profileUrl: `https://www.youtube.com/channel/${c.id}`,
    bio: c.snippet?.description ?? null,
    avatarUrl: bestThumb(c.snippet?.thumbnails),
    createdAt: c.snippet?.publishedAt ?? null,
    metrics: st
      ? {
          followers: hidden ? null : toCount(st.subscriberCount),
          following: null,
          postsCount: toCount(st.videoCount),
          extra: { totalViews: toCount(st.viewCount) },
          missing: {
            following: 'NOT_SUPPORTED',
            ...(hidden ? { followers: 'HIDDEN_BY_OWNER' as const } : {}),
          },
          collectedAt,
        }
      : null,
    provenance: provenance(source, collectedAt),
  };
}

export function normalizeVideoMetrics(v: VideoResource, collectedAt: string): PostMetrics {
  const st = v.statistics ?? {};
  const missing: PostMetrics['missing'] = { shares: 'NOT_SUPPORTED', saves: 'NOT_SUPPORTED' };
  // Absent likeCount = owner hid likes; absent commentCount = comments disabled.
  if (st.likeCount === undefined) missing.likes = 'HIDDEN_BY_OWNER';
  if (st.commentCount === undefined) missing.comments = 'DISABLED';
  if (st.viewCount === undefined) missing.views = 'NOT_PROVIDED';
  return {
    postExternalId: v.id,
    views: toCount(st.viewCount),
    likes: toCount(st.likeCount),
    comments: toCount(st.commentCount),
    shares: null,
    saves: null,
    extra: {},
    missing,
    collectedAt,
  };
}

function contentType(v: VideoResource): ContentType {
  const live = v.snippet?.liveBroadcastContent;
  if (live === 'live' || live === 'upcoming') return 'live';
  // The Data API has no reliable "is Short" flag; we do NOT infer it from duration.
  return 'video';
}

export function normalizeVideo(v: VideoResource, source: string, collectedAt: string): Post {
  const sn = v.snippet;
  if (!sn) throw new CollectorError('SCHEMA_CHANGED', `videos.list item ${v.id} missing snippet`);
  const text = `${sn.title ?? ''}\n${sn.description ?? ''}`;
  return {
    platform: 'youtube',
    externalId: v.id,
    accountExternalId: sn.channelId,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    contentType: contentType(v),
    title: sn.title ?? null,
    caption: sn.description ?? null,
    hashtags: extractHashtags(text),
    language: sn.defaultLanguage ?? sn.defaultAudioLanguage ?? null,
    thumbnailUrl: bestThumb(sn.thumbnails),
    durationSeconds: isoDurationToSeconds(v.contentDetails?.duration),
    publishedAt: sn.publishedAt ?? null,
    metrics: v.statistics ? normalizeVideoMetrics(v, collectedAt) : null,
    provenance: provenance(source, collectedAt),
  };
}
