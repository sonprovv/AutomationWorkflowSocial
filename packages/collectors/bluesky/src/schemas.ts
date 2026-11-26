import { z } from 'zod';

/**
 * Minimal schemas for the Bluesky AppView responses we rely on.
 * Only fields the adapter reads are required; extra fields pass through.
 * Ref: https://endpoints.bsky.app/openapi.bluesky-app.json (checked 2026-11-26)
 */

const count = z.number().int().nonnegative().optional();

export const profileBasic = z.looseObject({
  did: z.string().startsWith('did:'),
  handle: z.string(),
  displayName: z.string().optional(),
  avatar: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
});

export const profileDetailed = profileBasic.extend({
  followersCount: count,
  followsCount: count,
  postsCount: count,
});
export type ProfileDetailed = z.infer<typeof profileDetailed>;

export const postView = z.looseObject({
  uri: z.string().startsWith('at://'),
  cid: z.string(),
  author: profileBasic,
  record: z.looseObject({
    text: z.string().optional(),
    createdAt: z.string().optional(),
    langs: z.array(z.string()).optional(),
    facets: z.array(z.unknown()).optional(),
  }),
  embed: z.looseObject({ $type: z.string() }).optional(),
  likeCount: count,
  repostCount: count,
  replyCount: count,
  quoteCount: count,
  bookmarkCount: count,
  indexedAt: z.string().optional(),
});
export type PostView = z.infer<typeof postView>;

export const searchActorsResponse = z.looseObject({
  actors: z.array(profileBasic),
  cursor: z.string().optional(),
});

export const searchPostsResponse = z.looseObject({
  posts: z.array(postView),
  cursor: z.string().optional(),
  hitsTotal: z.number().optional(),
});

export const authorFeedResponse = z.looseObject({
  feed: z.array(
    z.looseObject({
      post: postView,
      reason: z.looseObject({ $type: z.string() }).optional(),
    }),
  ),
  cursor: z.string().optional(),
});

export const getPostsResponse = z.looseObject({ posts: z.array(postView) });

export const resolveHandleResponse = z.looseObject({ did: z.string().startsWith('did:') });

export const threadViewPost: z.ZodType<{ $type?: string; post?: PostView; replies?: unknown[] }> = z.looseObject({
  $type: z.string().optional(),
  post: postView.optional(),
  replies: z.array(z.unknown()).optional(),
});

export const getPostThreadResponse = z.looseObject({ thread: threadViewPost });

export const createSessionResponse = z.looseObject({
  did: z.string(),
  handle: z.string(),
  accessJwt: z.string(),
});
