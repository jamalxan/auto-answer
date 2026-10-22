/**
 * ETAP 13 — the 24-hour publishing quota (FR-S3): Meta's real
 * content_publishing_limit, cached for 10 minutes, plus what we already
 * scheduled into the same window; a Meta failure falls back to the default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ getPublishingLimit: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/publish", () => ({ getPublishingLimit: mocks.getPublishingLimit }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => `dec:${v}` }));

import { accountQuota, quotaWindowFull } from "@/lib/content/quota";

const NOW = new Date("2026-10-24T10:00:00Z");

beforeEach(() => {
  resetDb();
  mocks.getPublishingLimit.mockReset().mockResolvedValue({ quotaUsage: 7, quotaTotal: 50 });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: "ig1", username: "u", accessToken: "enc", tokenStatus: "ACTIVE" });
});

describe("accountQuota", () => {
  it("reads Meta on the first call and caches the usage on the account", async () => {
    const q = await accountQuota("acc1", NOW);
    expect(q).toMatchObject({ used: 7, total: 50, scheduledNext24h: 0, source: "api" });
    expect(mocks.getPublishingLimit).toHaveBeenCalledWith("dec:enc", "ig1");
    const acc = db.rows("instagramAccount")[0];
    expect(acc.publishQuotaUsed).toBe(7);
    expect(acc.publishQuotaCheckedAt).toEqual(NOW);
  });

  it("uses the cached value within 10 minutes", async () => {
    await accountQuota("acc1", NOW);
    const q = await accountQuota("acc1", new Date(NOW.getTime() + 5 * 60_000));
    expect(q.source).toBe("cache");
    expect(mocks.getPublishingLimit).toHaveBeenCalledTimes(1);
    await accountQuota("acc1", new Date(NOW.getTime() + 11 * 60_000));
    expect(mocks.getPublishingLimit).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default total when Meta fails", async () => {
    mocks.getPublishingLimit.mockRejectedValue(new Error("boom"));
    const q = await accountQuota("acc1", NOW);
    expect(q).toMatchObject({ used: 0, total: 50, source: "default" });
  });

  it("counts posts scheduled into the next 24 hours", async () => {
    db.seed("scheduledPost", { id: "p1", workspaceId: "ws1", instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: new Date(NOW.getTime() + 3_600_000) });
    db.seed("scheduledPost", { id: "p2", workspaceId: "ws1", instagramAccountId: "acc1", type: "FEED_IMAGE", status: "READY_TO_PUBLISH", scheduledAt: new Date(NOW.getTime() + 7_200_000) });
    db.seed("scheduledPost", { id: "p3", workspaceId: "ws1", instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: new Date(NOW.getTime() + 30 * 3_600_000) });
    db.seed("scheduledPost", { id: "p4", workspaceId: "ws1", instagramAccountId: "acc1", type: "FEED_IMAGE", status: "DRAFT", scheduledAt: new Date(NOW.getTime() + 3_600_000) });
    const q = await accountQuota("acc1", NOW);
    expect(q.scheduledNext24h).toBe(2);
  });
});

describe("quotaWindowFull", () => {
  it("is full when used + scheduled + extra exceeds the total", () => {
    expect(quotaWindowFull({ used: 49, total: 50, scheduledNext24h: 1 })).toBe(true);
    expect(quotaWindowFull({ used: 48, total: 50, scheduledNext24h: 1 })).toBe(false);
    expect(quotaWindowFull({ used: 40, total: 50, scheduledNext24h: 5 }, 6)).toBe(true);
  });
});
