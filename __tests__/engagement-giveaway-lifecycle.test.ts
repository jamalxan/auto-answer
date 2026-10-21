/**
 * Giveaway lifecycle (commit → draw → confirm → disqualify/re-draw), winner
 * notification and exports against the in-memory database.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(),
  sendCommentReply: vi.fn(),
  notifyWorkspaceChats: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  markTokenBroken: vi.fn(),
  forgetAccountGate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendDirectMessage: mocks.sendDirectMessage,
  sendCommentReply: mocks.sendCommentReply,
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => (value.startsWith("enc:") ? value.slice(4) : `plain:${value}`),
  encryptToken: (value: string) => `enc:${value}`,
}));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/telegram/notify", () => ({ notifyWorkspaceChats: mocks.notifyWorkspaceChats }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: mocks.forgetAccountGate }));

import { BACKFILL_CAP, FOLLOW_CHECKS_PER_SECOND, COLLECT_BATCH } from "@/lib/engagement/config";
import { exportDrawRecord, exportEntriesCsv } from "@/lib/engagement/giveaway/export";
import {
  activateGiveaway,
  archiveGiveaway,
  closeAndCommit,
  confirmDraw,
  disqualifyEntry,
  drawGiveaway,
  markEntry,
  resolveUnverifiable,
  verifyStoredDraw,
} from "@/lib/engagement/giveaway/lifecycle";
import { notifyWinners, winnerMessages } from "@/lib/engagement/giveaway/notify";

const NOW = new Date("2026-10-20T12:00:00Z");
const WS = "ws1";
const IG_ID = "17841400000000001";
const POST = "18000000000000777";
const rows = (model: string) => db.rows(model);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let account: Record<string, unknown>;
let giveawayId: string;

function seedGiveaway(extra: Record<string, unknown> = {}) {
  const g = db.seed("giveaway", {
    workspaceId: WS,
    instagramAccountId: account.id,
    name: "Yozgi giveaway",
    mediaId: POST,
    rules: {},
    windowStart: new Date("2026-10-19T00:00:00Z"),
    windowEnd: new Date("2026-10-25T00:00:00Z"),
    status: "DRAFT",
    winnersCount: 2,
    backupCount: 1,
    ...extra,
  });
  giveawayId = g.id as string;
  return g;
}

function seedEntries(count: number, status = "ELIGIBLE") {
  for (let i = 0; i < count; i++) {
    db.seed("giveawayEntry", {
      giveawayId,
      workspaceId: WS,
      igUserId: String(6000 + i),
      username: `user${i}`,
      firstCommentId: `c${i}`,
      firstCommentText: "ha",
      firstCommentAt: new Date("2026-10-19T10:00:00Z"),
      status,
    });
  }
}

const entryOf = (igUserId: string) => rows("giveawayEntry").find((e) => e.igUserId === igUserId)!;
const drawRows = () => rows("giveawayDraw").sort((a, b) => (a.sequence as number) - (b.sequence as number));

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  db.seed("workspace", { id: WS });
  account = db.seed("instagramAccount", { workspaceId: WS, instagramId: IG_ID, username: "shop", accessToken: "tok" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, periodStart: NOW });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.sendDirectMessage.mockResolvedValue({ recipient_id: "r", message_id: "m1" });
  mocks.sendCommentReply.mockResolvedValue({ id: "reply1" });
  mocks.notifyWorkspaceChats.mockResolvedValue(1);
});

describe("contract constants", () => {
  it("exposes the agreed limits", () => {
    expect(BACKFILL_CAP).toBe(5000);
    expect(FOLLOW_CHECKS_PER_SECOND).toBe(2);
    expect(COLLECT_BATCH).toBe(500);
  });
});

describe("activate / close / commit", () => {
  it("activates a draft, refreshes the webhook gate, refuses a second ACTIVE giveaway on the same post", async () => {
    seedGiveaway();
    const active = await activateGiveaway(WS, giveawayId);
    expect(active.status).toBe("ACTIVE");
    expect(mocks.forgetAccountGate).toHaveBeenCalledWith(IG_ID);
    await expect(activateGiveaway(WS, giveawayId)).rejects.toMatchObject({ status: 409 });

    seedGiveaway();
    await expect(activateGiveaway(WS, giveawayId)).rejects.toMatchObject({ status: 409 });
  });

  it("is workspace scoped", async () => {
    seedGiveaway();
    await expect(activateGiveaway("other", giveawayId)).rejects.toMatchObject({ status: 404 });
    await expect(closeAndCommit("other", giveawayId)).rejects.toMatchObject({ status: 404 });
    await expect(drawGiveaway("other", giveawayId)).rejects.toMatchObject({ status: 404 });
  });

  it("commits before the draw: sha256(seed) is stored, the seed encrypted, no draw exists yet", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(5);
    const { giveaway, commitment } = await closeAndCommit(WS, giveawayId);

    expect(giveaway.status).toBe("CLOSED");
    const stored = rows("giveaway")[0];
    expect(stored.seedCommitment).toBe(commitment);
    expect(String(stored.seedEncrypted)).toMatch(/^enc:[0-9a-f]{64}$/);
    expect(sha256(String(stored.seedEncrypted).slice(4))).toBe(commitment);
    expect(stored.committedAt).toBeInstanceOf(Date);
    expect(rows("giveawayDraw")).toHaveLength(0);
    expect(stored.entriesCount).toBe(5);
    await expect(closeAndCommit(WS, giveawayId)).rejects.toMatchObject({ status: 409 });
  });
});

describe("draw", () => {
  beforeEach(async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(8);
    db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId: "6900", firstCommentId: "x", firstCommentText: "", firstCommentAt: NOW, status: "INELIGIBLE" });
    db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId: "6901", firstCommentId: "y", firstCommentText: "", firstCommentAt: NOW, status: "PENDING_CHECK" });
  });

  it("refuses to draw before the commitment", async () => {
    await expect(drawGiveaway(WS, giveawayId)).rejects.toMatchObject({ status: 409 });
  });

  it("stores sequence 1 with the revealed seed, marks only winners, keeps ineligible and pending entries out", async () => {
    const { commitment } = await closeAndCommit(WS, giveawayId);
    const draw = await drawGiveaway(WS, giveawayId);

    expect(draw.sequence).toBe(1);
    expect(draw.status).toBe("DRAWN");
    expect(draw.seedCommitment).toBe(commitment);
    expect(sha256(draw.seedRevealed)).toBe(commitment);
    expect(draw.entrantsCount).toBe(8);
    expect(draw.winnerEntryIds).toHaveLength(2);
    expect(draw.backupEntryIds).toHaveLength(1);
    expect(draw.verification).toContain(draw.seedRevealed);
    expect(rows("giveaway")[0].status).toBe("DRAWN");

    const winners = rows("giveawayEntry").filter((e) => e.status === "WINNER").map((e) => e.id);
    expect(winners.sort()).toEqual([...draw.winnerEntryIds].sort());
    expect(entryOf("6900").status).toBe("INELIGIBLE");
    expect(entryOf("6901").status).toBe("PENDING_CHECK");
    expect(draw.winnerEntryIds).not.toContain(entryOf("6900").id);

    await expect(drawGiveaway(WS, giveawayId)).rejects.toMatchObject({ status: 409 });
    await expect(verifyStoredDraw(WS, giveawayId, 1)).resolves.toMatchObject({ ok: true, problems: [] });
  });

  it("verification fails when the stored record is tampered with", async () => {
    await closeAndCommit(WS, giveawayId);
    await drawGiveaway(WS, giveawayId);
    drawRows()[0].winnerEntryIds = [...(drawRows()[0].winnerEntryIds as string[])].reverse();
    const check = await verifyStoredDraw(WS, giveawayId, 1);
    expect(check.ok).toBe(false);
  });

  it("confirm is required before notifying and is idempotent", async () => {
    await closeAndCommit(WS, giveawayId);
    await drawGiveaway(WS, giveawayId);
    await expect(notifyWinners(WS, giveawayId, 1, NOW)).rejects.toMatchObject({ status: 409 });
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(mocks.sendCommentReply).not.toHaveBeenCalled();
    expect(mocks.notifyWorkspaceChats).not.toHaveBeenCalled();

    const confirmed = await confirmDraw(WS, giveawayId, 1, "u1");
    expect(confirmed).toMatchObject({ status: "CONFIRMED", confirmedByUserId: "u1" });
    expect((await confirmDraw(WS, giveawayId, 1, "u2")).confirmedByUserId).toBe("u1");
    await expect(confirmDraw(WS, giveawayId, 9, "u1")).rejects.toMatchObject({ status: 404 });
  });

  it("disqualifying a winner VOIDs the draw and re-draws over the remaining entrants with a NEW commitment", async () => {
    const { commitment: first } = await closeAndCommit(WS, giveawayId);
    const draw1 = await drawGiveaway(WS, giveawayId);
    await confirmDraw(WS, giveawayId, 1, "u1");
    const out = String(draw1.winnerEntryIds[0]);

    const result = await disqualifyEntry(WS, giveawayId, out, "u1", "Qoidani buzdi");

    expect(result.redrawn).toBe(true);
    const [old, fresh] = drawRows();
    expect(old).toMatchObject({ sequence: 1, status: "VOIDED" });
    expect(String(old.voidReason)).toContain("Qoidani buzdi");
    expect(fresh).toMatchObject({ sequence: 2, status: "DRAWN" });
    expect(fresh.seedCommitment).not.toBe(first);
    expect(fresh.seedRevealed).not.toBe(old.seedRevealed);
    expect(sha256(String(fresh.seedRevealed))).toBe(fresh.seedCommitment);
    expect(rows("giveaway")[0].seedCommitment).toBe(fresh.seedCommitment);
    // 8 eligible minus the disqualified one
    expect(fresh.entrantsCount).toBe(7);
    expect(fresh.winnerEntryIds).not.toContain(out);
    expect(fresh.backupEntryIds).not.toContain(out);
    expect(rows("giveawayEntry").find((e) => e.id === out)).toMatchObject({ status: "DISQUALIFIED", disqualifiedBy: "u1" });
    const winners = rows("giveawayEntry").filter((e) => e.status === "WINNER").map((e) => e.id);
    expect(winners.sort()).toEqual([...(fresh.winnerEntryIds as string[])].sort());
    expect(rows("giveaway")[0].status).toBe("DRAWN");

    // the new draw must be confirmed again; both sequences still verify
    await expect(notifyWinners(WS, giveawayId, 2, NOW)).rejects.toMatchObject({ status: 409 });
    await expect(verifyStoredDraw(WS, giveawayId, 1)).resolves.toMatchObject({ ok: true });
    await expect(verifyStoredDraw(WS, giveawayId, 2)).resolves.toMatchObject({ ok: true });
    await expect(notifyWinners(WS, giveawayId, 1, NOW)).rejects.toMatchObject({ status: 409 });
    await expect(disqualifyEntry(WS, giveawayId, out, "u1", "yana")).rejects.toMatchObject({ status: 409 });
  });

  it("disqualifying someone who did not win does not touch the draw", async () => {
    await closeAndCommit(WS, giveawayId);
    const draw = await drawGiveaway(WS, giveawayId);
    const bystander = rows("giveawayEntry").find((e) => e.status === "ELIGIBLE" && !draw.backupEntryIds.includes(e.id as string))!;
    const result = await disqualifyEntry(WS, giveawayId, bystander.id as string, "u1", "Soxta akkaunt");
    expect(result.redrawn).toBe(false);
    expect(rows("giveawayDraw")).toHaveLength(1);
    expect(drawRows()[0].status).toBe("DRAWN");
    await expect(disqualifyEntry(WS, giveawayId, bystander.id as string, "u1", " ")).rejects.toMatchObject({ status: 409 });
    await expect(verifyStoredDraw(WS, giveawayId, 1)).resolves.toMatchObject({ ok: true });
  });
});

describe("manual review", () => {
  it("marks a PENDING_CHECK entry, refuses others, and resolves UNVERIFIABLE ones in bulk", async () => {
    seedGiveaway({ status: "ACTIVE" });
    for (const [i, followResult] of ["UNVERIFIABLE", "UNVERIFIABLE", "NOT_CHECKED"].entries()) {
      db.seed("giveawayEntry", {
        giveawayId, workspaceId: WS, igUserId: String(6000 + i), firstCommentId: `c${i}`, firstCommentText: "ha",
        firstCommentAt: NOW, status: "PENDING_CHECK", followResult,
      });
    }
    db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId: "6100", firstCommentId: "c", firstCommentText: "", firstCommentAt: NOW, status: "ELIGIBLE" });

    const one = await markEntry(WS, giveawayId, entryOf("6002").id as string, "INELIGIBLE", "u1", "Soxta");
    expect(one).toMatchObject({ status: "INELIGIBLE", ineligibleReason: "Soxta" });
    expect((one.checks as { manual: { by: string } }).manual.by).toBe("u1");
    await expect(markEntry(WS, giveawayId, entryOf("6100").id as string, "INELIGIBLE", "u1")).rejects.toMatchObject({ status: 409 });

    const bulk = await resolveUnverifiable(WS, giveawayId, "ELIGIBLE", "u1");
    expect(bulk.count).toBe(2);
    expect(entryOf("6000").status).toBe("ELIGIBLE");
    expect(entryOf("6001").status).toBe("ELIGIBLE");
    expect(entryOf("6002").status).toBe("INELIGIBLE");
    expect(rows("giveaway")[0].eligibleCount).toBe(3);
  });

  it("archives only a non-active giveaway", async () => {
    seedGiveaway({ status: "ACTIVE" });
    await expect(archiveGiveaway(WS, giveawayId)).rejects.toMatchObject({ status: 409 });
    rows("giveaway")[0].status = "DRAWN";
    expect((await archiveGiveaway(WS, giveawayId)).status).toBe("ARCHIVED");
  });
});

describe("notifyWinners", () => {
  async function drawnAndConfirmed() {
    seedGiveaway({ status: "ACTIVE", winnersCount: 4, backupCount: 0 });
    // 6000: contact with an open window, 6001: no signal, 6002: opted out with an open window,
    // 6003: no contact but wrote a DM two hours ago
    seedEntries(4);
    db.seed("crmContact", { workspaceId: WS, instagramAccountId: account.id, igUserId: "6000", lastInboundAt: new Date(NOW.getTime() - 3600_000) });
    db.seed("crmContact", {
      workspaceId: WS, instagramAccountId: account.id, igUserId: "6002", lastInboundAt: new Date(NOW.getTime() - 3600_000), optedOutAt: new Date("2026-10-01T00:00:00Z"),
    });
    db.seed("instagramEvent", {
      workspaceId: WS, instagramAccountId: account.id, eventType: "DIRECT_MESSAGE", senderId: "6003", messageId: "dm1",
      timestamp: new Date(NOW.getTime() - 2 * 3600_000), rawPayload: {},
    });
    await closeAndCommit(WS, giveawayId);
    await drawGiveaway(WS, giveawayId);
    await confirmDraw(WS, giveawayId, 1, "u1");
  }

  it("DM when the window is open, public reply otherwise (also when opted out), one Telegram summary", async () => {
    await drawnAndConfirmed();
    const result = await notifyWinners(WS, giveawayId, 1, NOW);

    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
    const dmTo = mocks.sendDirectMessage.mock.calls.map((c) => c[2]).sort();
    expect(dmTo).toEqual(["6000", "6003"]);
    expect(mocks.sendDirectMessage.mock.calls[0][0]).toBe("plain:tok");
    expect(mocks.sendDirectMessage.mock.calls[0][3]).toContain("Yozgi giveaway");

    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(2);
    const replyUnder = mocks.sendCommentReply.mock.calls.map((c) => c[1]).sort();
    expect(replyUnder).toEqual(["c1", "c2"]);
    expect(mocks.sendCommentReply.mock.calls[0][2]).toMatch(/^@user\d tabriklaymiz! Direct'ga yozing$/);

    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(mocks.notifyWorkspaceChats.mock.calls[0][1]).toContain("g'oliblari");
    expect(result.telegram).toBe("SENT");

    const byChannel = (channel: string, status: string) =>
      rows("giveawayNotification").filter((n) => n.channel === channel && n.status === status).length;
    expect(byChannel("DM", "SENT")).toBe(2);
    expect(byChannel("DM", "SKIPPED")).toBe(1); // opted out
    expect(byChannel("PUBLIC_REPLY", "SENT")).toBe(2);
    expect(byChannel("TELEGRAM", "SENT")).toBe(1);
    const optedOut = result.winners.find((w) => w.entryId === entryOf("6002").id)!;
    expect(optedOut).toMatchObject({ dm: "SKIPPED", publicReply: "SENT" });
  });

  it("a rerun sends nothing new", async () => {
    await drawnAndConfirmed();
    await notifyWinners(WS, giveawayId, 1, NOW);
    const logged = rows("giveawayNotification").length;
    const again = await notifyWinners(WS, giveawayId, 1, NOW);

    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(2);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(rows("giveawayNotification")).toHaveLength(logged);
    expect(again.winners.every((w) => w.alreadyNotified)).toBe(true);
  });

  it("falls back to the public reply when the DM is refused, and retries what failed", async () => {
    await drawnAndConfirmed();
    mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: false, reason: "limit" });
    mocks.sendCommentReply.mockRejectedValueOnce(new Error("Graph down"));

    const result = await notifyWinners(WS, giveawayId, 1, NOW);

    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(result.winners.filter((w) => w.dm === "SKIPPED")).toHaveLength(3);
    expect(result.winners.filter((w) => w.publicReply === "FAILED")).toHaveLength(1);
    expect(result.winners.filter((w) => w.publicReply === "SENT")).toHaveLength(3);

    mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, periodStart: NOW });
    await notifyWinners(WS, giveawayId, 1, NOW);
    // the winner whose reply failed is retried (now by DM when the window is open, else reply); nobody gets a second one
    const sentPerEntry = new Map<string, number>();
    for (const n of rows("giveawayNotification")) {
      if (n.status === "SENT" && (n.channel === "DM" || n.channel === "PUBLIC_REPLY")) {
        sentPerEntry.set(n.entryId as string, (sentPerEntry.get(n.entryId as string) ?? 0) + 1);
      }
    }
    expect([...sentPerEntry.values()].every((count) => count === 1)).toBe(true);
    expect(sentPerEntry.size).toBe(4);
  });

  it("two concurrent notify calls send exactly once (claim first, then send)", async () => {
    await drawnAndConfirmed();
    const [a, b] = await Promise.all([notifyWinners(WS, giveawayId, 1, NOW), notifyWinners(WS, giveawayId, 1, NOW)]);

    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(2);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    // One row per (entry, channel): the unique key held.
    const keys = rows("giveawayNotification").map((n) => `${n.entryId}|${n.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows("giveawayNotification").every((n) => n.status !== "PENDING")).toBe(true);
    // The loser of every claim reports "uncertain", never a second send.
    expect([...a.winners, ...b.winners].filter((w) => w.uncertain).length).toBeGreaterThan(0);
  });

  it("a crash between the send and the settle (stale PENDING) is never resent automatically", async () => {
    await drawnAndConfirmed();
    // All four entrants win (winnersCount 4), but their order comes from the
    // random seed. Pin the entrant whose window is open (6000): only a DM
    // candidate is held back by a stale DM claim; an entrant with no window
    // would legitimately get the public reply and make this test flaky.
    const winnerId = entryOf("6000").id as string;
    // The draw is random: make sure this winner's DM window is open, otherwise
    // the DM claim is skipped and the test depends on who won.
    const drawn = rows("giveawayEntry").find((e) => e.id === winnerId)!;
    const known = rows("crmContact").find((c) => c.igUserId === drawn.igUserId);
    if (known) {
      known.lastInboundAt = new Date(NOW.getTime() - 3600_000);
      known.optedOutAt = null;
    } else db.seed("crmContact", { workspaceId: WS, instagramAccountId: account.id, igUserId: drawn.igUserId, lastInboundAt: new Date(NOW.getTime() - 3600_000) });
    db.seed("giveawayNotification", {
      giveawayId, entryId: winnerId, channel: "DM", status: "PENDING", snapshot: { sequence: 1 }, updatedAt: new Date(NOW.getTime() - 20 * 60_000),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await notifyWinners(WS, giveawayId, 1, NOW);

    const winner = result.winners.find((w) => w.entryId === winnerId)!;
    expect(winner).toMatchObject({ dm: "NONE", publicReply: "NONE", uncertain: true });
    const winnerEntry = rows("giveawayEntry").find((e) => e.id === winnerId)!;
    expect(mocks.sendDirectMessage.mock.calls.map((c) => c[2])).not.toContain(winnerEntry.igUserId);
    expect(mocks.sendCommentReply.mock.calls.map((c) => c[1])).not.toContain(winnerEntry.firstCommentId);
    expect(rows("giveawayNotification").find((n) => n.entryId === winnerId && n.channel === "DM")!.status).toBe("PENDING");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("noaniq — qo'lda tekshiring"))).toBe(true);
    expect(String(mocks.notifyWorkspaceChats.mock.calls[0][1])).toContain("noaniq — qo'lda tekshiring");
    warn.mockRestore();
  });

  it("FAILED / SKIPPED rows are claimed again by updateMany; a SENT row never is", async () => {
    await drawnAndConfirmed();
    mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: false, reason: "limit" });
    await notifyWinners(WS, giveawayId, 1, NOW);
    const before = rows("giveawayNotification").filter((n) => n.channel === "DM" && n.status === "SKIPPED").length;
    expect(before).toBeGreaterThan(0);
    mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, periodStart: NOW });
    mocks.sendDirectMessage.mockClear();
    mocks.sendCommentReply.mockClear();
    await notifyWinners(WS, giveawayId, 1, NOW);
    // Everyone already got a public reply (SENT): nothing is sent a second time.
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(mocks.sendCommentReply).not.toHaveBeenCalled();
  });

  it("renders Uzbek and Russian templates without a username too", () => {
    expect(winnerMessages("uz", "ali", "Yoz").publicReply).toBe("@ali tabriklaymiz! Direct'ga yozing");
    expect(winnerMessages("uz", "ali", "Yoz").dm).toContain("Tabriklaymiz, @ali!");
    expect(winnerMessages("ru", "ali", "Лето").dm).toContain("@ali");
    expect(winnerMessages("uz", null, "Yoz").publicReply).toBe("Tabriklaymiz! Direct'ga yozing");
    expect(winnerMessages("uz", null, "Yoz").dm).toMatch(/^Tabriklaymiz! /);
  });
});

describe("review fixes: races and guards", () => {
  it("two concurrent closeAndCommit calls: exactly one commitment survives, the other gets 409", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(4);
    const results = await Promise.allSettled([closeAndCommit(WS, giveawayId), closeAndCommit(WS, giveawayId)]);

    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof closeAndCommit>>>[];
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ status: 409 });
    const stored = rows("giveaway")[0];
    expect(stored.seedCommitment).toBe(ok[0].value.commitment);
    expect(sha256(String(stored.seedEncrypted).slice(4))).toBe(ok[0].value.commitment);
    // The draw reveals the very seed the published commitment belongs to.
    const draw = await drawGiveaway(WS, giveawayId);
    expect(sha256(String(draw.seedRevealed))).toBe(ok[0].value.commitment);
  });

  it("double activate / archive are guarded too", async () => {
    seedGiveaway({ status: "DRAFT" });
    const activate = await Promise.allSettled([activateGiveaway(WS, giveawayId), activateGiveaway(WS, giveawayId)]);
    expect(activate.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((activate.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    rows("giveaway")[0].status = "CLOSED";
    const archive = await Promise.allSettled([archiveGiveaway(WS, giveawayId), archiveGiveaway(WS, giveawayId)]);
    expect(archive.every((r) => r.status === "fulfilled")).toBe(true);
    expect(rows("giveaway")[0].status).toBe("ARCHIVED");
  });

  it("closeAndCommit publishes the entrant hash and count; the draw uses the same list", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(5);
    seedEntries(0);
    db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId: "7000", firstCommentId: "x", firstCommentText: "", firstCommentAt: NOW, status: "PENDING_CHECK" });
    const closed = await closeAndCommit(WS, giveawayId);
    expect(closed.entrantsCount).toBe(5);
    expect(closed.pendingExcluded).toBe(1);
    const draw = await drawGiveaway(WS, giveawayId);
    expect(draw.entrantsHash).toBe(closed.entrantsHash);
    expect(draw.entrantsCount).toBe(5);
    expect(draw.pendingExcluded).toBe(1);
  });

  it("resolveUnverifiable also settles NOT_CHECKED entries and counts only what changed (manual ones excluded)", async () => {
    seedGiveaway({ status: "ACTIVE" });
    const seedOne = (igUserId: string, extra: Record<string, unknown>) =>
      db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId, firstCommentId: `c${igUserId}`, firstCommentText: "ha", firstCommentAt: NOW, status: "PENDING_CHECK", ...extra });
    seedOne("1", { followResult: "NOT_CHECKED" });
    seedOne("2", { followResult: "UNVERIFIABLE" });
    seedOne("3", { followResult: "NOT_CHECKED", checks: { manual: { status: "ELIGIBLE", at: NOW.toISOString() } } });
    const closed = await closeAndCommit(WS, giveawayId);
    expect(closed.pendingExcluded).toBe(3);

    const { count } = await resolveUnverifiable(WS, giveawayId, "ELIGIBLE", "u1");
    expect(count).toBe(2);
    expect(entryOf("1").status).toBe("ELIGIBLE");
    expect(entryOf("2").status).toBe("ELIGIBLE");
    expect(entryOf("3").status).toBe("PENDING_CHECK");
    expect((await resolveUnverifiable(WS, giveawayId, "ELIGIBLE", "u1")).count).toBe(0);
  });

  it("confirmDraw cannot flip a concurrently VOIDED draw back to CONFIRMED", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(6);
    await closeAndCommit(WS, giveawayId);
    await drawGiveaway(WS, giveawayId);
    const confirming = confirmDraw(WS, giveawayId, 1, "u1");
    rows("giveawayDraw")[0].status = "VOIDED";
    await expect(confirming).rejects.toMatchObject({ status: 409 });
    expect(rows("giveawayDraw")[0].status).toBe("VOIDED");
    expect(rows("giveawayDraw")[0].confirmedAt).toBeNull();
  });

  it("two concurrent draws: one wins, the other gets a 409 with an Uzbek message (not a 500)", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(6);
    await closeAndCommit(WS, giveawayId);
    const results = await Promise.allSettled([drawGiveaway(WS, giveawayId), drawGiveaway(WS, giveawayId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, message: expect.stringContaining("Qur'a") });
    expect(rows("giveawayDraw")).toHaveLength(1);
  });

  it("the draw record lists voided sequences with reasons and hashes and counts owner changes after the commit", async () => {
    seedGiveaway({ status: "ACTIVE", winnersCount: 1, backupCount: 0 });
    seedEntries(6);
    db.seed("giveawayEntry", { giveawayId, workspaceId: WS, igUserId: "7000", firstCommentId: "x", firstCommentText: "", firstCommentAt: NOW, status: "PENDING_CHECK", followResult: "UNVERIFIABLE" });
    await closeAndCommit(WS, giveawayId);
    const committedAt = rows("giveaway")[0].committedAt as Date;
    await markEntry(WS, giveawayId, entryOf("7000").id as string, "ELIGIBLE", "u1");
    // the manual decision is stamped after every commit
    expect(committedAt).toBeInstanceOf(Date);
    (entryOf("7000").checks as { manual: { at: string } }).manual.at = "2099-01-01T00:00:00.000Z";
    const first = await drawGiveaway(WS, giveawayId);
    await confirmDraw(WS, giveawayId, 1, "u1");
    await disqualifyEntry(WS, giveawayId, (first.winnerEntryIds as string[])[0], "u1", "Soxta akkaunt");

    const record = await exportDrawRecord(WS, giveawayId, 2);
    expect(record).toContain("O'zgarishlar commitdan keyin: 1");
    expect(record).toMatch(/#1 VOIDED — ishtirokchilar: 7, hash: [0-9a-f]{64} — bekor qilish sababi: Diskvalifikatsiya: Soxta akkaunt/);
    expect(record).toMatch(/#2 DRAWN — ishtirokchilar: 6, hash: [0-9a-f]{64}/);
    expect((await verifyStoredDraw(WS, giveawayId, 2)).changesAfterCommit).toBe(1);
  });
});

describe("exports", () => {
  it("escapes formulas in the CSV and reports one row per entry", async () => {
    seedGiveaway({ status: "ACTIVE" });
    db.seed("giveawayEntry", {
      giveawayId, workspaceId: WS, igUserId: "6001", username: "ali", firstCommentId: "c1",
      firstCommentText: "=HYPERLINK(\"http://evil\",\"x\")", firstCommentAt: NOW, status: "ELIGIBLE", taggedUsernames: ["vali"],
    });
    db.seed("giveawayEntry", {
      giveawayId, workspaceId: WS, igUserId: "6002", username: "-bad", firstCommentId: "c2",
      firstCommentText: "salom, dunyo", firstCommentAt: new Date(NOW.getTime() + 1000), status: "INELIGIBLE", ineligibleReason: "+cmd|x",
    });

    const csv = await exportEntriesCsv(WS, giveawayId);
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("igUserId,username,status,sabab,obuna,izohlar,belgilangan,story,birinchi_izoh,izoh_vaqti");
    expect(lines).toHaveLength(3);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain("\"'=HYPERLINK(");
    expect(csv).toContain("'@-bad");
    expect(csv).toContain("'+cmd|x");
    expect(csv).toContain("\"salom, dunyo\"");
    await expect(exportEntriesCsv("other", giveawayId)).rejects.toMatchObject({ status: 404 });
  });

  it("the draw record carries the commitment, the seed, the verification line and the sorted entrants", async () => {
    seedGiveaway({ status: "ACTIVE" });
    seedEntries(6);
    const { commitment } = await closeAndCommit(WS, giveawayId);
    const draw = await drawGiveaway(WS, giveawayId);

    const record = await exportDrawRecord(WS, giveawayId, 1);

    expect(record).toContain(`Commitment (sha256 of seed text): ${commitment}`);
    expect(record).toContain(`Seed (ochilgan): ${draw.seedRevealed}`);
    expect(record).toContain(`Tekshirish satri: ${draw.verification}`);
    const list = record.split("\n").filter((line) => /^6\d{3}$/.test(line));
    expect(list).toEqual(["6000", "6001", "6002", "6003", "6004", "6005"]);
    await expect(exportDrawRecord(WS, giveawayId, 5)).rejects.toMatchObject({ status: 404 });
  });
});
