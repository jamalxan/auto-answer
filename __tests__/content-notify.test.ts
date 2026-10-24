/**
 * ETAP 13 Faza 2 (WP-E) — spec §11 notifications: "Kvota 80%" (Telegram,
 * once per account per 24 h) and "Ertaga X ta post, akkaunt BROKEN"
 * (Telegram + email, once per account per local day).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

type Q = { used: number; total: number; scheduledNext24h: number; resetsAt: Date | null; source: "api" | "cache" | "default" };
const mocks = vi.hoisted(() => ({
  notifyWorkspaceChats: vi.fn<(ws: string, text: string) => Promise<number>>(async () => 1),
  alertWorkspace: vi.fn<(ws: string, subject: string, html: string, plain: string) => Promise<undefined>>(async () => undefined),
  accountQuota: vi.fn(async (): Promise<Q> => ({ used: 10, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/telegram/notify", () => ({ notifyWorkspaceChats: mocks.notifyWorkspaceChats, alertWorkspace: mocks.alertWorkspace }));
vi.mock("@/lib/content/quota", () => ({ accountQuota: mocks.accountQuota }));

import { notifyBrokenAccounts, notifyQuotaIfHigh, sweepNotifications } from "@/lib/content/notify";

const WS = "ws1";
const NOW = new Date("2026-10-24T08:00:00Z"); // 13:00 in Tashkent
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

function account(id: string, over: Record<string, unknown> = {}) {
  return db.seed("instagramAccount", { id, workspaceId: WS, instagramId: `ig-${id}`, username: `user_${id}`, accessToken: "t", tokenStatus: "ACTIVE", canPublish: true, ...over });
}
function post(id: string, accountId: string, over: Record<string, unknown> = {}) {
  return db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: accountId, type: "FEED_IMAGE", status: "SCHEDULED", autoPublish: true, manualReason: null, deletedAt: null, scheduledAt: hours(5), ...over });
}

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.accountQuota.mockResolvedValue({ used: 10, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" });
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
});

describe("Kvota 80%", () => {
  it("stays quiet below 80%", async () => {
    account("a1");
    mocks.accountQuota.mockResolvedValue({ used: 30, total: 50, scheduledNext24h: 9, resetsAt: null, source: "api" });
    expect(await notifyQuotaIfHigh("a1", NOW)).toBe(false);
    expect(mocks.notifyWorkspaceChats).not.toHaveBeenCalled();
  });

  it("sends one Telegram notice at 80% (published + queued) and records the dashboard event, then waits 24 h", async () => {
    account("a1");
    mocks.accountQuota.mockResolvedValue({ used: 30, total: 50, scheduledNext24h: 10, resetsAt: null, source: "api" });
    expect(await notifyQuotaIfHigh("a1", NOW)).toBe(true);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(mocks.notifyWorkspaceChats.mock.calls[0][1]).toContain("40/50");
    expect(db.rows("operationalEvent")).toEqual([expect.objectContaining({ workspaceId: WS, level: "WARNING", source: "WORKER" })]);
    expect(await notifyQuotaIfHigh("a1", hours(23))).toBe(false);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(await notifyQuotaIfHigh("a1", hours(25))).toBe(true);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(2);
  });

  it("is per account", async () => {
    account("a1");
    account("a2");
    mocks.accountQuota.mockResolvedValue({ used: 45, total: 50, scheduledNext24h: 0, resetsAt: null, source: "api" });
    expect(await notifyQuotaIfHigh("a1", NOW)).toBe(true);
    expect(await notifyQuotaIfHigh("a2", NOW)).toBe(true);
  });
});

describe("Ertaga X ta post, akkaunt BROKEN", () => {
  it("warns by Telegram + email when a BROKEN account has auto posts in the next 24 h, once per day", async () => {
    account("a1", { tokenStatus: "BROKEN" });
    post("p1", "a1", { scheduledAt: hours(3) });
    post("p2", "a1", { scheduledAt: hours(20) });
    post("late", "a1", { scheduledAt: hours(30) });
    post("manual", "a1", { autoPublish: false, manualReason: "USER_CHOICE" });
    post("draft", "a1", { status: "DRAFT" });
    expect(await notifyBrokenAccounts(NOW)).toBe(1);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    const [ws, subject, html] = mocks.alertWorkspace.mock.calls[0];
    expect(ws).toBe(WS);
    expect(subject).toContain("2 ta post");
    expect(html).toContain("@user_a1");
    // same local day: deduped
    expect(await notifyBrokenAccounts(hours(6))).toBe(0);
    // next local day (Tashkent midnight = 19:00 UTC)
    expect(await notifyBrokenAccounts(hours(12))).toBe(1);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("covers canPublish=false and ignores healthy accounts or accounts with nothing due", async () => {
    account("noscope", { canPublish: false });
    post("p1", "noscope");
    account("ok");
    post("p2", "ok");
    account("idle", { tokenStatus: "BROKEN" });
    expect(await notifyBrokenAccounts(NOW)).toBe(1);
    expect(mocks.alertWorkspace.mock.calls[0][2]).toContain("ruxsat");
  });
});

describe("sweepNotifications", () => {
  it("checks quota only for accounts that publish now or soon, and runs the BROKEN check", async () => {
    account("busy");
    post("p1", "busy", { scheduledAt: hours(2) });
    account("quiet");
    account("broken", { tokenStatus: "BROKEN" });
    post("p2", "broken", { scheduledAt: hours(4) });
    mocks.accountQuota.mockResolvedValue({ used: 49, total: 50, scheduledNext24h: 1, resetsAt: null, source: "api" });
    const r = await sweepNotifications(NOW);
    expect(r).toEqual({ quotaWarnings: 2, brokenWarnings: 1 });
    expect(mocks.accountQuota.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(["broken", "busy"]);
  });
});
