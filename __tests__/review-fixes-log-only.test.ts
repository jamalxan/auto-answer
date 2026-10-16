/**
 * Review fixes M1/M2: log-only rows (IGNORED + NO_AUTOMATION_REASON) never
 * block a later claim, never count as history, keep a trimmed payload and are
 * deleted by the retention sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: vi.fn().mockResolvedValue(undefined),
}));

import { forgetAccountGate, handOverClaimedComment, ingestWebhookPayload, storeEvent } from "@/lib/triggers/ingest";
import { decideDmTrigger } from "@/lib/triggers/claim";
import { notLogOnlyEventWhere, NO_AUTOMATION_REASON, type NormalizedInstagramEvent } from "@/lib/triggers/normalize";
import { sweepLogOnlyEvents } from "@/lib/triggers/worker";
import { prisma } from "@/lib/db/client";

const IG = "17841400000000001";

function commentPayload(id: string, text = "narx") {
  return {
    object: "instagram",
    entry: [{ id: IG, time: 1760000000000, changes: [{ field: "comments", value: { id, text, from: { id: "u1" }, media: { id: "p1" } } }] }],
  };
}

function event(over: Partial<NormalizedInstagramEvent> = {}): NormalizedInstagramEvent {
  return {
    type: "COMMENT",
    instagramAccountId: IG,
    senderId: "u1",
    messageId: "c1",
    mediaId: "p1",
    text: "narx",
    hasAttachment: false,
    timestamp: new Date(),
    raw: { big: "x".repeat(5000) },
    ...over,
  };
}

const account = { id: "acc1", workspaceId: "ws1" };

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  vi.unstubAllEnvs();
  db.seed("workspace", { id: "ws1", name: "T" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG, username: "shop", accessToken: "x" });
});

describe("M2: log-only rows are trimmed", () => {
  it("stores a summary with text cut to 500 chars and no raw item", async () => {
    await ingestWebhookPayload(commentPayload("c1", "a".repeat(900)));
    const row = db.rows("instagramEvent")[0] as { text: string; rawPayload: Record<string, unknown>; error: string };
    expect(row.error).toBe(NO_AUTOMATION_REASON);
    expect(row.text).toHaveLength(500);
    expect(row.rawPayload.item).toBeUndefined();
    expect(row.rawPayload.summary).toMatchObject({ type: "COMMENT", messageId: "c1", senderId: "u1" });
  });
});

describe("M1: a log-only row does not occupy the key", () => {
  it("a real event for the same messageId upgrades the row to PENDING with the full payload", async () => {
    expect(await storeEvent(account, event(), { ignoredReason: NO_AUTOMATION_REASON })).toBeTruthy();
    const id = await storeEvent(account, event());
    expect(id).toBeTruthy();
    const rows = db.rows("instagramEvent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, processingStatus: "PENDING", error: null });
    expect((rows[0].rawPayload as { item?: unknown }).item).toBeTruthy();
    // and a second real store is a plain duplicate
    expect(await storeEvent(account, event())).toBeNull();
  });

  it("a real (non log-only) row is never overwritten", async () => {
    await storeEvent(account, event());
    expect(await storeEvent(account, event({ text: "other" }))).toBeNull();
    expect(await storeEvent(account, event(), { ignoredReason: NO_AUTOMATION_REASON })).toBeNull();
    expect(db.rows("instagramEvent")[0]).toMatchObject({ text: "narx", processingStatus: "PENDING" });
  });

  it("handOverClaimedComment answers a comment logged before the campaign existed", async () => {
    await storeEvent(account, event(), { ignoredReason: NO_AUTOMATION_REASON });
    const handed = await handOverClaimedComment({
      instagramId: IG,
      commentId: "c1",
      text: "narx",
      commenterId: "u1",
      mediaId: "p1",
    });
    expect(handed).toBe(true);
    expect(db.rows("instagramEvent")[0]).toMatchObject({ processingStatus: "PENDING" });
  });

  it("backtrack's known-comment query ignores log-only rows", async () => {
    await storeEvent(account, event({ messageId: "logged" }), { ignoredReason: NO_AUTOMATION_REASON });
    await storeEvent(account, event({ messageId: "real" }));
    const rows = await prisma.instagramEvent.findMany({
      where: { instagramAccountId: "acc1", messageId: { in: ["logged", "real"] }, ...notLogOnlyEventWhere() },
      select: { messageId: true },
    });
    expect(rows.map((r) => r.messageId)).toEqual(["real"]);
  });

  it("a log-only DM is not a previous interaction (still NEW_CONTACT), a real one is", async () => {
    db.seed("triggerCampaign", {
      id: "camp", workspaceId: "ws1", instagramAccountId: "acc1", kind: "CAMPAIGN", triggerType: "DIRECT_MESSAGE",
      active: true, audience: "NEW_CONTACT", name: "c", keywords: [], matchingMode: "EVERY", intents: [], mediaScope: "ANY", mediaIds: [],
      priority: 0, reopenAfterHours: 72, cooldownHours: 0, sourceFilter: "ANY", adIds: [], refs: [],
    });
    const at = new Date();
    await storeEvent(account, event({ type: "DIRECT_MESSAGE", messageId: "d0", timestamp: new Date(at.getTime() - 3600_000) }), {
      ignoredReason: NO_AUTOMATION_REASON,
    });
    const query = { accountId: "acc1", senderId: "u1", type: "DIRECT_MESSAGE" as const, text: "salom", at };
    expect((await decideDmTrigger(query)).campaign?.id).toBe("camp");
    await storeEvent(account, event({ type: "DIRECT_MESSAGE", messageId: "d1", timestamp: new Date(at.getTime() - 1800_000) }));
    expect((await decideDmTrigger(query)).campaign).toBeNull();
  });
});

describe("M2: retention sweep", () => {
  it("deletes only log-only rows older than 14 days", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const old = new Date(now.getTime() - 15 * 24 * 3600_000);
    const fresh = new Date(now.getTime() - 3 * 24 * 3600_000);
    const base = { workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: "u", text: "" };
    db.seed("instagramEvent", { ...base, id: "e1", messageId: "m1", processingStatus: "IGNORED", error: NO_AUTOMATION_REASON, createdAt: old });
    db.seed("instagramEvent", { ...base, id: "e2", messageId: "m2", processingStatus: "IGNORED", error: NO_AUTOMATION_REASON, createdAt: fresh });
    db.seed("instagramEvent", { ...base, id: "e3", messageId: "m3", processingStatus: "IGNORED", error: "boshqa sabab", createdAt: old });
    db.seed("instagramEvent", { ...base, id: "e4", messageId: "m4", processingStatus: "DONE", error: null, createdAt: old });
    expect(await sweepLogOnlyEvents(now)).toBe(1);
    expect(db.rows("instagramEvent").map((r) => r.id).sort()).toEqual(["e2", "e3", "e4"]);
  });

  it("deletes at most 1000 rows per pass", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const old = new Date(now.getTime() - 20 * 24 * 3600_000);
    for (let i = 0; i < 1200; i++) {
      db.seed("instagramEvent", { id: `x${i}`, workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: "u", messageId: `m${i}`, text: "", processingStatus: "IGNORED", error: NO_AUTOMATION_REASON, createdAt: old });
    }
    expect(await sweepLogOnlyEvents(now)).toBe(1000);
    expect(await sweepLogOnlyEvents(now)).toBe(200);
  });
});
