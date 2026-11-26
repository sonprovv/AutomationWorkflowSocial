import {
  CollectorError,
  extractHashtags,
  makeProvenance,
  toCount,
  type Account,
  type ContentType,
  type Post,
  type PostMetrics,
  type Provenance,
} from '@sss/collector-core';
import type { PostView, ProfileDetailed } from './schemas.ts';

export const PROVIDER_ID = 'bluesky-appview';
export const SCHEMA_VERSION = 'bluesky-appview@2026-11-26';
export const POLICY_ID = 'bluesky-public-v0-unverified';

export function provenance(source: string, collectedAt?: string): Provenance {
  return makeProvenance({
    providerId: PROVIDER_ID,
    policyId: POLICY_ID,
    schemaVersion: SCHEMA_VERSION,
    source,
    collectedAt,
  });
}

/** at://did/app.bsky.feed.post/rkey -> { did, rkey } */
export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(uri);
  if (!m) throw new CollectorError('INVALID_INPUT', `Not an AT URI: ${uri}`);
  return { repo: m[1]!, collection: m[2]!, rkey: m[3]! };
}

export function postWebUrl(uri: string): string {
  const { repo, rkey } = parseAtUri(uri);
  return `https://bsky.app/profile/${repo}/post/${rkey}`;
}

export function profileWebUrl(did: string): string {
  return `https://bsky.app/profile/${did}`;
}

export type ActorInput = { kind: 'did' | 'handle'; value: string; postRkey?: string };

/**
 * Accepts: https://bsky.app/profile/<handle|did>[/post/<rkey>], @handle, handle, did:plc:…, did:web:…
 * Handles are DNS names (must contain a dot).
 */
export function parseActorInput(raw: string): ActorInput {
  const s = raw.trim();
  if (!s) throw new CollectorError('INVALID_INPUT', 'Empty account input');
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new CollectorError('INVALID_INPUT', `Invalid URL: ${s}`);
    }
    if (!['bsky.app', 'www.bsky.app'].includes(url.hostname)) {
      throw new CollectorError('INVALID_INPUT', `Not a bsky.app URL: ${url.hostname}`);
    }
    const m = /^\/profile\/([^/]+)(?:\/post\/([^/]+))?\/?$/.exec(url.pathname);
    if (!m) throw new CollectorError('INVALID_INPUT', `Unrecognized Bluesky URL path: ${url.pathname}`);
    const actor = decodeURIComponent(m[1]!);
    return { ...classifyActor(actor), ...(m[2] ? { postRkey: m[2] } : {}) };
  }
  return classifyActor(s.replace(/^@/, ''));
}

function classifyActor(a: string): ActorInput {
  if (/^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(a)) return { kind: 'did', value: a };
  if (/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(a)) {
    return { kind: 'handle', value: a.toLowerCase() };
  }
  throw new CollectorError('INVALID_INPUT', `Not a Bluesky handle or DID: ${a}`);
}

export function normalizeProfile(p: ProfileDetailed, source: string, collectedAt: string): Account {
  const hasCounts = 'followersCount' in p || 'followsCount' in p || 'postsCount' in p;
  return {
    platform: 'bluesky',
    externalId: p.did,
    username: p.handle === 'handle.invalid' ? null : p.handle,
    displayName: p.displayName?.trim() || null,
    profileUrl: profileWebUrl(p.did),
    bio: p.description ?? null,
    avatarUrl: p.avatar ?? null,
    createdAt: p.createdAt ?? null,
    metrics: hasCounts
      ? {
          followers: toCount(p.followersCount),
          following: toCount(p.followsCount),
          postsCount: toCount(p.postsCount),
          extra: {},
          missing: {},
          collectedAt,
        }
      : null, // searchActors returns profileView without counts — unknown, not zero.
    provenance: provenance(source, collectedAt),
  };
}

function contentTypeOf(embedType: string | undefined): ContentType {
  if (!embedType) return 'text';
  if (embedType.startsWith('app.bsky.embed.video')) return 'video';
  if (embedType.startsWith('app.bsky.embed.images')) return 'image';
  if (embedType.startsWith('app.bsky.embed.external')) return 'link';
  if (embedType.startsWith('app.bsky.embed.recordWithMedia')) return 'mixed';
  if (embedType.startsWith('app.bsky.embed.record')) return 'text'; // quote post
  return 'unknown';
}

function thumbnailOf(embed: Record<string, unknown> | undefined): string | null {
  if (!embed) return null;
  const t = embed['$type'] as string;
  if (t?.startsWith('app.bsky.embed.video')) return (embed['thumbnail'] as string) ?? null;
  if (t?.startsWith('app.bsky.embed.images')) {
    const imgs = embed['images'] as { thumb?: string }[] | undefined;
    return imgs?.[0]?.thumb ?? null;
  }
  if (t?.startsWith('app.bsky.embed.external')) {
    return ((embed['external'] as { thumb?: string } | undefined)?.thumb as string) ?? null;
  }
  if (t?.startsWith('app.bsky.embed.recordWithMedia')) {
    return thumbnailOf(embed['media'] as Record<string, unknown> | undefined);
  }
  return null;
}

function facetTags(facets: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const f of facets ?? []) {
    const features = (f as { features?: { $type?: string; tag?: string }[] }).features ?? [];
    for (const feat of features) {
      if (feat.$type === 'app.bsky.richtext.facet#tag' && feat.tag) out.push(feat.tag.toLowerCase());
    }
  }
  return out;
}

export function normalizeMetrics(p: PostView, collectedAt: string): PostMetrics {
  return {
    postExternalId: p.uri,
    views: null,
    likes: toCount(p.likeCount),
    comments: toCount(p.replyCount),
    shares: toCount(p.repostCount),
    saves: toCount(p.bookmarkCount),
    extra: { quotes: toCount(p.quoteCount) },
    missing: { views: 'NOT_SUPPORTED' }, // Bluesky exposes no view/impression count.
    collectedAt,
  };
}

export function normalizePost(p: PostView, source: string, collectedAt: string): Post {
  const text = p.record.text ?? null;
  const embed = p.embed as Record<string, unknown> | undefined;
  return {
    platform: 'bluesky',
    externalId: p.uri,
    accountExternalId: p.author.did,
    url: postWebUrl(p.uri),
    contentType: contentTypeOf(p.embed?.$type),
    title: null,
    caption: text,
    hashtags: [...new Set([...facetTags(p.record.facets), ...extractHashtags(text)])],
    language: p.record.langs?.[0] ?? null,
    thumbnailUrl: thumbnailOf(embed),
    durationSeconds: null, // not exposed by the AppView video embed view
    publishedAt: p.record.createdAt ?? null,
    metrics: normalizeMetrics(p, collectedAt),
    provenance: provenance(source, collectedAt),
  };
}
