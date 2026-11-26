import { z } from 'zod';

/** Minimal YouTube Data API v3 schemas (fields the adapter reads). Ref: https://developers.google.com/youtube/v3/docs */

const thumbnails = z
  .record(z.string(), z.looseObject({ url: z.string() }))
  .optional();

const numStr = z.union([z.string(), z.number()]).optional();

export const channelResource = z.looseObject({
  id: z.string(),
  snippet: z
    .looseObject({
      title: z.string().optional(),
      description: z.string().optional(),
      customUrl: z.string().optional(),
      publishedAt: z.string().optional(),
      thumbnails,
      country: z.string().optional(),
    })
    .optional(),
  statistics: z
    .looseObject({
      viewCount: numStr,
      subscriberCount: numStr,
      hiddenSubscriberCount: z.boolean().optional(),
      videoCount: numStr,
    })
    .optional(),
  contentDetails: z
    .looseObject({ relatedPlaylists: z.looseObject({ uploads: z.string().optional() }).optional() })
    .optional(),
});
export type ChannelResource = z.infer<typeof channelResource>;

export const channelListResponse = z.looseObject({
  items: z.array(channelResource).optional(),
  nextPageToken: z.string().optional(),
});

export const videoResource = z.looseObject({
  id: z.string(),
  snippet: z
    .looseObject({
      publishedAt: z.string().optional(),
      channelId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      thumbnails,
      tags: z.array(z.string()).optional(),
      defaultLanguage: z.string().optional(),
      defaultAudioLanguage: z.string().optional(),
      liveBroadcastContent: z.string().optional(),
    })
    .optional(),
  contentDetails: z.looseObject({ duration: z.string().optional() }).optional(),
  statistics: z
    .looseObject({
      viewCount: numStr,
      likeCount: numStr,
      commentCount: numStr,
      favoriteCount: numStr,
    })
    .optional(),
  status: z.looseObject({ privacyStatus: z.string().optional(), uploadStatus: z.string().optional() }).optional(),
});
export type VideoResource = z.infer<typeof videoResource>;

export const videoListResponse = z.looseObject({
  items: z.array(videoResource).optional(),
  nextPageToken: z.string().optional(),
});

export const searchListResponse = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.looseObject({
          kind: z.string(),
          videoId: z.string().optional(),
          channelId: z.string().optional(),
        }),
        snippet: z
          .looseObject({
            channelId: z.string().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            publishedAt: z.string().optional(),
            thumbnails,
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  pageInfo: z.looseObject({ totalResults: z.number().optional() }).optional(),
});

export const playlistItemsResponse = z.looseObject({
  items: z
    .array(
      z.looseObject({
        contentDetails: z.looseObject({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

export const commentThreadsResponse = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        snippet: z.looseObject({
          videoId: z.string().optional(),
          topLevelComment: z.looseObject({
            id: z.string(),
            snippet: z.looseObject({
              textOriginal: z.string().optional(),
              textDisplay: z.string().optional(),
              authorChannelId: z.looseObject({ value: z.string() }).optional(),
              likeCount: z.number().optional(),
              publishedAt: z.string().optional(),
            }),
          }),
        }),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});
