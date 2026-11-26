import type { Account, Post } from '@sss/collector-core';
import type { Prisma } from '@sss/database';
import type { EffectivePolicy } from '@sss/policy-engine';
import { big } from './serialize.ts';

type Tx = Prisma.TransactionClient;

/**
 * Upsert helpers shared by track (resolve) and sync. All writes are idempotent by stable external ID.
 * Metric snapshots respect the provider policy: without `allowHistoricalSnapshots`, only the latest
 * snapshot is kept (older rows for that entity are deleted in the same transaction).
 */
export async function upsertAccount(tx: Tx, a: Account, providerId: string): Promise<{ id: string; created: boolean }> {
  const existing = await tx.socialAccount.findUnique({ where: { platform_externalId: { platform: a.platform, externalId: a.externalId } }, select: { id: true } });
  const data = {
    username: a.username,
    displayName: a.displayName,
    profileUrl: a.profileUrl,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    accountCreatedAt: a.createdAt ? new Date(a.createdAt) : null,
    status: 'ACTIVE' as const,
    providerId,
    policyId: a.provenance.policyId,
    schemaVersion: a.provenance.schemaVersion,
    lastCollectedAt: new Date(a.provenance.collectedAt),
  };
  const row = await tx.socialAccount.upsert({
    where: { platform_externalId: { platform: a.platform, externalId: a.externalId } },
    create: { platform: a.platform, externalId: a.externalId, ...data },
    update: data,
    select: { id: true },
  });
  if (a.metrics) {
    if (!(await policyAllowsHistory(tx, a.provenance.policyId))) await tx.accountMetric.deleteMany({ where: { accountId: row.id } });
    await tx.accountMetric.create({
      data: {
        accountId: row.id,
        collectedAt: new Date(a.metrics.collectedAt),
        followers: big(a.metrics.followers),
        following: big(a.metrics.following),
        postsCount: big(a.metrics.postsCount),
        extra: a.metrics.extra as Prisma.InputJsonValue,
        missing: a.metrics.missing as Prisma.InputJsonValue,
        providerId,
        policyId: a.provenance.policyId,
      },
    });
  }
  return { id: row.id, created: !existing };
}

export async function upsertPost(
  tx: Tx,
  p: Post,
  accountId: string,
  providerId: string,
  policy: EffectivePolicy,
): Promise<{ id: string; created: boolean }> {
  const existing = await tx.post.findUnique({ where: { platform_externalId: { platform: p.platform, externalId: p.externalId } }, select: { id: true, firstSeenAt: true } });
  const collectedAt = new Date(p.provenance.collectedAt);
  const publishedAt = p.publishedAt ? new Date(p.publishedAt) : null;
  const data = {
    url: p.url,
    contentType: p.contentType,
    title: p.title,
    caption: p.caption,
    hashtags: p.hashtags,
    language: p.language,
    thumbnailUrl: p.thumbnailUrl,
    durationSeconds: p.durationSeconds,
    publishedAt,
    lastCollectedAt: collectedAt,
    status: 'AVAILABLE' as const,
    providerId,
    policyId: p.provenance.policyId,
    schemaVersion: p.provenance.schemaVersion,
  };
  const row = await tx.post.upsert({
    where: { platform_externalId: { platform: p.platform, externalId: p.externalId } },
    create: { platform: p.platform, externalId: p.externalId, accountId, sortAt: publishedAt ?? collectedAt, firstSeenAt: collectedAt, ...data },
    update: { ...data, sortAt: publishedAt ?? existing?.firstSeenAt ?? collectedAt },
    select: { id: true },
  });
  if (p.metrics) {
    if (!policy.allowHistoricalSnapshots) await tx.postMetric.deleteMany({ where: { postId: row.id } });
    await tx.postMetric.create({
      data: {
        postId: row.id,
        collectedAt: new Date(p.metrics.collectedAt),
        views: big(p.metrics.views),
        likes: big(p.metrics.likes),
        comments: big(p.metrics.comments),
        shares: big(p.metrics.shares),
        saves: big(p.metrics.saves),
        extra: p.metrics.extra as Prisma.InputJsonValue,
        missing: p.metrics.missing as Prisma.InputJsonValue,
        providerId,
        policyId: policy.policyId,
      },
    });
  }
  return { id: row.id, created: !existing };
}

async function policyAllowsHistory(tx: Tx, policyId: string): Promise<boolean> {
  const p = await tx.dataPolicy.findUnique({ where: { id: policyId }, select: { allowedOperations: true } });
  return (p?.allowedOperations as Record<string, unknown> | undefined)?.allowHistoricalSnapshots === true;
}
