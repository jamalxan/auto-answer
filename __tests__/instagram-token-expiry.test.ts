import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ alertWorkspace: vi.fn(async () => {}) }));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace }));

import { runInstagramTokenExpiryWarnings } from "../lib/meta/token-expiry";
import { db, resetDb } from "./helpers/db-instance";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T09:00:00Z");

function seed(daysLeft: number | null, extra: Record<string, unknown> = {}) {
  return db.seed("instagramAccount", {
    id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1", accessToken: "enc", tokenStatus: "ACTIVE",
    tokenExpiresAt: daysLeft === null ? null : new Date(NOW.getTime() + daysLeft * DAY),
    ...extra,
  });
}

beforeEach(() => {
  resetDb();
  mocks.alertWorkspace.mockClear();
  db.seed("workspace", { id: "w1", name: "T" });
});

describe("Instagram token expiry warnings (B-30)", () => {
  it("warns at 7 days, again at 1 day, never twice for the same threshold", async () => {
    seed(7);
    expect(await runInstagramTokenExpiryWarnings(NOW)).toBe(1);
    expect(await runInstagramTokenExpiryWarnings(new Date(NOW.getTime() + 3 * DAY))).toBe(0);
    expect(await runInstagramTokenExpiryWarnings(new Date(NOW.getTime() + 6.5 * DAY))).toBe(1);
    expect(await runInstagramTokenExpiryWarnings(new Date(NOW.getTime() + 6.8 * DAY))).toBe(0);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("names the real days left, not the threshold", async () => {
    seed(3);
    await runInstagramTokenExpiryWarnings(NOW);
    const event = db.rows("operationalEvent")[0];
    expect(event).toMatchObject({ level: "WARNING", source: "TOKEN_REFRESH" });
    expect(String(event.message)).toContain("3 kundan");
    expect(String(event.message)).not.toContain("7 kundan");
    expect(db.rows("instagramAccount")[0].tokenWarnedAt).toEqual(NOW);
  });

  it("ignores far-off, expired, broken and unknown expiries", async () => {
    seed(30);
    db.seed("instagramAccount", { id: "a2", workspaceId: "w1", username: "b", instagramId: "ig2", accessToken: "x", tokenStatus: "BROKEN", tokenExpiresAt: new Date(NOW.getTime() + 2 * DAY) });
    db.seed("instagramAccount", { id: "a3", workspaceId: "w1", username: "c", instagramId: "ig3", accessToken: "x", tokenStatus: "ACTIVE", tokenExpiresAt: new Date(NOW.getTime() - DAY) });
    db.seed("instagramAccount", { id: "a4", workspaceId: "w1", username: "d", instagramId: "ig4", accessToken: "x", tokenStatus: "ACTIVE", tokenExpiresAt: null });
    expect(await runInstagramTokenExpiryWarnings(NOW)).toBe(0);
    expect(mocks.alertWorkspace).not.toHaveBeenCalled();
  });
});
