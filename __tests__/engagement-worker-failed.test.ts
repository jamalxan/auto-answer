/**
 * The engagement worker's `failed` handler: a giveaway-backfill job that died
 * (worker restart, crash) must not leave the giveaway RUNNING forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const handlers = vi.hoisted(() => ({ failed: null as null | ((job: unknown, err: Error) => void) }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("bullmq", () => ({
  Worker: class {
    on(event: string, handler: (job: unknown, err: Error) => void) {
      if (event === "failed") handlers.failed = handler;
      return this;
    }
  },
}));

import { createEngagementWorker } from "@/lib/engagement/worker";

beforeEach(() => {
  resetDb();
  handlers.failed = null;
});

describe("engagement worker failed handler", () => {
  it("marks a RUNNING backfill FAILED when its job fails", async () => {
    db.seed("workspace", { id: "ws1" });
    const giveaway = db.seed("giveaway", { workspaceId: "ws1", instagramAccountId: "a1", name: "G", mediaId: "m", rules: {}, windowStart: new Date(), windowEnd: new Date(), backfillStatus: "RUNNING" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createEngagementWorker();
    handlers.failed!({ id: "j1", name: "giveaway-backfill", data: { workspaceId: "ws1", giveawayId: giveaway.id } }, new Error("Job stalled"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.rows("giveaway")[0]).toMatchObject({ backfillStatus: "FAILED" });
    expect(String(db.rows("giveaway")[0].backfillError)).toContain("Job stalled");
    spy.mockRestore();
  });

  it("leaves other jobs' giveaways alone", async () => {
    const giveaway = db.seed("giveaway", { workspaceId: "ws1", instagramAccountId: "a1", name: "G", mediaId: "m", rules: {}, windowStart: new Date(), windowEnd: new Date(), backfillStatus: "RUNNING" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createEngagementWorker();
    handlers.failed!({ id: "j2", name: "giveaway-notify", data: { workspaceId: "ws1", giveawayId: giveaway.id, sequence: 1 } }, new Error("x"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.rows("giveaway")[0].backfillStatus).toBe("RUNNING");
    spy.mockRestore();
  });
});
