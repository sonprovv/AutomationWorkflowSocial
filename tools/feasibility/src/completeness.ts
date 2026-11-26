import type { Account, Post } from '@sss/collector-core';

/** Share of records where each field is non-null (1 = always present). Missing ≠ 0: we only measure presence. */
export function completeness(accounts: Account[], posts: Post[]): Record<string, unknown> {
  const rate = <T>(xs: T[], f: (x: T) => unknown) =>
    xs.length ? Math.round((xs.filter((x) => { const v = f(x); return v !== null && v !== undefined && v !== ''; }).length / xs.length) * 1000) / 1000 : null;
  const uniqPosts = [...new Map(posts.map((p) => [p.externalId, p])).values()];
  return {
    accounts: {
      n: accounts.length,
      username: rate(accounts, (a) => a.username),
      displayName: rate(accounts, (a) => a.displayName),
      bio: rate(accounts, (a) => a.bio),
      avatarUrl: rate(accounts, (a) => a.avatarUrl),
      createdAt: rate(accounts, (a) => a.createdAt),
      followers: rate(accounts, (a) => a.metrics?.followers),
      following: rate(accounts, (a) => a.metrics?.following),
      postsCount: rate(accounts, (a) => a.metrics?.postsCount),
    },
    posts: {
      n: uniqPosts.length,
      title: rate(uniqPosts, (p) => p.title),
      caption: rate(uniqPosts, (p) => p.caption),
      language: rate(uniqPosts, (p) => p.language),
      thumbnailUrl: rate(uniqPosts, (p) => p.thumbnailUrl),
      durationSeconds: rate(uniqPosts, (p) => p.durationSeconds),
      publishedAt: rate(uniqPosts, (p) => p.publishedAt),
      hashtagsNonEmpty: rate(uniqPosts, (p) => (p.hashtags.length ? 1 : null)),
      views: rate(uniqPosts, (p) => p.metrics?.views),
      likes: rate(uniqPosts, (p) => p.metrics?.likes),
      comments: rate(uniqPosts, (p) => p.metrics?.comments),
      shares: rate(uniqPosts, (p) => p.metrics?.shares),
      saves: rate(uniqPosts, (p) => p.metrics?.saves),
      contentTypes: uniqPosts.reduce<Record<string, number>>((o, p) => ((o[p.contentType] = (o[p.contentType] ?? 0) + 1), o), {}),
    },
  };
}
