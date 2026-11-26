/** Shared adapter contract (packages/collectors/core/src/contract.ts) against a fake AppView. SYNTHETIC data. */
import { UsageMeter } from '@sss/collector-core';
import { runAdapterContract } from '@sss/collector-core/contract';
import { noSleep } from '@sss/collector-core/testing';
import { BlueskyAdapter } from '../src/index.ts';

const DID = 'did:plc:contractfixture00000000001';
const uri = (rkey: string) => `at://${DID}/app.bsky.feed.post/${rkey}`;
const post = (rkey: string, createdAt: string, likes: number | null) => ({
  uri: uri(rkey),
  cid: `bafy${rkey}`,
  author: { did: DID, handle: 'contract.example.com' },
  record: { text: `synthetic ${rkey} #fixture`, createdAt },
  indexedAt: createdAt,
  ...(likes === null ? {} : { likeCount: likes, repostCount: 0, replyCount: 1, quoteCount: 0 }),
});
const ALL = [post('3c4', '2026-11-24T04:00:00.000Z', 4), post('3c3', '2026-11-24T03:00:00.000Z', null), post('3c2', '2026-11-24T02:00:00.000Z', 2), post('3c1', '2026-11-24T01:00:00.000Z', 1)];

runAdapterContract({
  name: 'bluesky',
  create: ({ baseUrl, meter }) => new BlueskyAdapter({ meter, baseUrls: { publicAppView: baseUrl, appView: baseUrl, entryway: baseUrl }, allowedHosts: ['127.0.0.1'], sleep: noSleep }),
  meter: () => new UsageMeter({ maxRequests: 100 }),
  exhaustedMeter: () => new UsageMeter({ maxRequests: 0 }),
  accountId: DID,
  profilePath: '/xrpc/app.bsky.actor.getProfile',
  metricsPostIds: { present: [uri('3c4'), uri('3c2')], deleted: uri('3c9') },
  routes: () => ({
    '/xrpc/app.bsky.actor.getProfile': () => ({ body: { did: DID, handle: 'contract.example.com', displayName: 'Contract (SYNTHETIC)', followersCount: 10, postsCount: 4 } }),
    '/xrpc/app.bsky.feed.getAuthorFeed': ({ url }) =>
      url.searchParams.get('cursor') === 'page-2'
        ? { body: { feed: ALL.slice(2).map((p) => ({ post: p })) } }
        : { body: { feed: ALL.slice(0, 2).map((p) => ({ post: p })), cursor: 'page-2' } },
    '/xrpc/app.bsky.feed.getPosts': ({ url }) => ({ body: { posts: ALL.filter((p) => url.searchParams.getAll('uris').includes(p.uri)) } }),
  }),
  notFoundRoutes: () => ({ '/xrpc/app.bsky.actor.getProfile': () => ({ status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } }) }),
});
