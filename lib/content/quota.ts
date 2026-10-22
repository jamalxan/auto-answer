/**
 * ETAP 13 — the 24-hour publishing quota (FR-S3, spec §3): Meta's own
 * content_publishing_limit (its docs say 50 or 100 — we read the real
 * number), cached on the account for ten minutes, plus the posts we have
 * already queued into the same sliding window.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getPublishingLimit } from "@/lib/meta/publish";
import { QUEUED } from "./transitions";

export const DEFAULT_QUOTA_TOTAL = 50;
const CACHE_MS = 10 * 60_000;
const WINDOW_MS = 24 * 3_600_000;

export interface AccountQuota {
  used: number;
  total: number;
  scheduledNext24h: number;
  /** When the oldest publish of the window leaves it; null when unknown. */
  resetsAt: Date | null;
  source: "api" | "cache" | "default";
}

export async function accountQuota(accountId: string, now: Date = new Date()): Promise<AccountQuota> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { instagramId: true, accessToken: true, publishQuotaUsed: true, publishQuotaCheckedAt: true },
  });
  if (!account) return { used: 0, total: DEFAULT_QUOTA_TOTAL, scheduledNext24h: 0, resetsAt: null, source: "default" };

  let used = account.publishQuotaUsed ?? 0;
  let total = DEFAULT_QUOTA_TOTAL;
  let source: AccountQuota["source"] = "cache";
  const fresh = account.publishQuotaCheckedAt && now.getTime() - account.publishQuotaCheckedAt.getTime() < CACHE_MS;
  if (!fresh) {
    try {
      const limit = await getPublishingLimit(decryptToken(account.accessToken), account.instagramId);
      used = limit.quotaUsage;
      total = limit.quotaTotal || DEFAULT_QUOTA_TOTAL;
      source = "api";
      await prisma.instagramAccount.update({ where: { id: accountId }, data: { publishQuotaUsed: used, publishQuotaCheckedAt: now } });
    } catch {
      used = account.publishQuotaUsed ?? 0;
      source = account.publishQuotaCheckedAt ? "cache" : "default";
    }
  }

  const [scheduledNext24h, oldestPublished] = await Promise.all([
    prisma.scheduledPost.count({
      where: { instagramAccountId: accountId, deletedAt: null, status: { in: QUEUED }, scheduledAt: { gte: now, lt: new Date(now.getTime() + WINDOW_MS) } },
    }),
    prisma.scheduledPost.findFirst({
      where: { instagramAccountId: accountId, status: "PUBLISHED", publishedAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
      orderBy: { publishedAt: "asc" },
      select: { publishedAt: true },
    }),
  ]);

  return {
    used,
    total,
    scheduledNext24h,
    resetsAt: oldestPublished?.publishedAt ? new Date(oldestPublished.publishedAt.getTime() + WINDOW_MS) : null,
    source,
  };
}

export function quotaWindowFull(q: Pick<AccountQuota, "used" | "total" | "scheduledNext24h">, extra = 1): boolean {
  return q.used + q.scheduledNext24h + extra > q.total;
}
