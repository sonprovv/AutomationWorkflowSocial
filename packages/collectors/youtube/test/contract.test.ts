/** Shared adapter contract (packages/collectors/core/src/contract.ts) against a fake YouTube Data API. SYNTHETIC data. */
import { UsageMeter } from '@sss/collector-core';
import { runAdapterContract } from '@sss/collector-core/contract';
import { noSleep } from '@sss/collector-core/testing';
import { YouTubeAdapter } from '../src/index.ts';

const CHANNEL = 'UCcontractfixture0000001';
const KEY = 'contract-test-key-not-real-1234';
const video = (id: string, publishedAt: string, likes: string | undefined) => ({
  id,
  snippet: { publishedAt, channelId: CHANNEL, title: `Synthetic ${id}`, description: '#fixture' },
  contentDetails: { duration: 'PT30S' },
  statistics: { viewCount: '100', ...(likes === undefined ? {} : { likeCount: likes }), commentCount: '1' },
});
const ALL = [video('CCCCCCCCCC4', '2026-11-24T04:00:00Z', '4'), video('CCCCCCCCCC3', '2026-11-24T03:00:00Z', undefined), video('CCCCCCCCCC2', '2026-11-24T02:00:00Z', '2'), video('CCCCCCCCCC1', '2026-11-24T01:00:00Z', '1')];

runAdapterContract({
  name: 'youtube',
  create: ({ baseUrl, meter }) => new YouTubeAdapter({ apiKey: KEY, meter, baseUrl: `${baseUrl}/youtube/v3/`, allowedHosts: ['127.0.0.1'], sleep: noSleep }),
  meter: () => new UsageMeter({ maxQuotaUnits: 1000 }),
  exhaustedMeter: () => new UsageMeter({ maxQuotaUnits: 0 }),
  accountId: CHANNEL,
  profilePath: '/youtube/v3/channels',
  metricsPostIds: { present: ['CCCCCCCCCC4', 'CCCCCCCCCC2'], deleted: 'GONEGONE009' },
  secret: KEY,
  routes: () => ({
    '/youtube/v3/channels': () => ({
      body: { items: [{ id: CHANNEL, snippet: { title: 'Contract (SYNTHETIC)', customUrl: '@contract' }, statistics: { subscriberCount: '10', videoCount: '4' }, contentDetails: { relatedPlaylists: { uploads: 'UUcontract' } } }] },
    }),
    '/youtube/v3/playlistItems': ({ url }) => {
      const page2 = url.searchParams.get('pageToken') === 'PAGE2';
      const ids = (page2 ? ALL.slice(2) : ALL.slice(0, 2)).map((v) => ({ contentDetails: { videoId: v.id } }));
      return { body: { items: ids, ...(page2 ? {} : { nextPageToken: 'PAGE2' }) } };
    },
    '/youtube/v3/videos': ({ url }) => {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      return { body: { items: ALL.filter((v) => ids.includes(v.id)) } };
    },
  }),
  notFoundRoutes: () => ({ '/youtube/v3/channels': () => ({ body: { kind: 'youtube#channelListResponse' } }) }),
});
