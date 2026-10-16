/**
 * Giveaway lifecycle, workspace scoped. Every call throws
 * EngagementServiceError (HTTP status + Uzbek message) for a state the owner
 * can fix.
 *
 *   DRAFT --activate--> ACTIVE --closeAndCommit--> CLOSED --draw--> DRAWN
 *                                                                    |
 *   confirmDraw (owner) -> notify.ts may announce; disqualifyEntry of a
 *   winner VOIDs the draw and runs a new sequence with a NEW commitment.
 *
 * Commit before draw: closeAndCommit stores sha256(seed) (public) and the
 * seed encrypted; the draw reveals the seed in GiveawayDraw. A re-draw after a
 * disqualification uses a fresh seed — the old one stays revealed on the
 * voided sequence, so nothing is hidden.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { conflict, EngagementServiceError, notFound, unprocessable } from "../errors";
import { forgetEngagementGate } from "../gate";
import { drainGiveaway, isManualEntry, refreshGiveawayCounters } from "./collector";
import { commitmentOf, createCommitment, drawWinners, hashEntrants } from "./draw";

export { verifyStoredDraw } from "./verify";
export { EngagementServiceError };

type Tx = Prisma.TransactionClient;

async function loadGiveaway(workspaceId: string, id: string) {
  const giveaway = await prisma.giveaway.findFirst({ where: { id, workspaceId } });
  if (!giveaway) throw notFound("Giveaway topilmadi");
  return giveaway;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

const SEQUENCE_CLASH = "Qur'a hozirgina boshqa so'rov bilan o'tkazildi — sahifani yangilang";

/** Two requests drew the same sequence: the second one gets a clear 409, not a 500. */
function mapSequenceClash(error: unknown): never {
  if (isUniqueViolation(error)) throw conflict(SEQUENCE_CLASH);
  throw error;
}

function manualChecks(existing: unknown, manual: Record<string, unknown>): Prisma.InputJsonValue {
  const base = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  return { ...base, manual } as Prisma.InputJsonValue;
}

// ─── Activate / close ─────────────────────────────────────────────────────────

export async function activateGiveaway(workspaceId: string, id: string) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status !== "DRAFT") throw conflict("Faqat qoralama giveaway'ni faollashtirish mumkin");
  if (giveaway.windowEnd <= giveaway.windowStart) throw unprocessable("Tugash vaqti boshlanishdan keyin bo'lishi kerak");

  const clash = await prisma.giveaway.findFirst({
    where: { instagramAccountId: giveaway.instagramAccountId, mediaId: giveaway.mediaId, status: "ACTIVE", NOT: { id } },
    select: { id: true },
  });
  if (clash) throw conflict("Bu post uchun boshqa giveaway allaqachon faol");

  // Guarded by the status read above: a double click activates once.
  const moved = await prisma.giveaway.updateMany({
    where: { id, workspaceId, status: "DRAFT" },
    data: { status: "ACTIVE", collectCursorAt: null, collectCursorId: null },
  });
  if (moved.count === 0) throw conflict("Giveaway holati o'zgargan — sahifani yangilang");
  await forgetEngagementGate(giveaway.instagramAccountId);
  return loadGiveaway(workspaceId, id);
}

/** Entries still waiting for a check do not enter the draw (the UI warns about them). */
async function countPendingExcluded(giveawayId: string): Promise<number> {
  return prisma.giveawayEntry.count({ where: { giveawayId, status: "PENDING_CHECK" } });
}

/**
 * Close entries and publish the commitment: seed generated, stored encrypted,
 * sha256 shown. The status flip is a guarded updateMany (ACTIVE only) and the
 * seed is generated right before it, so two concurrent calls can never
 * overwrite a published commitment: the loser gets a 409 and its seed is
 * discarded.
 */
export async function closeAndCommit(workspaceId: string, id: string) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status !== "ACTIVE") throw conflict("Faqat faol giveaway'ni yopish mumkin");

  // The last minute of comments must not be lost to the collector's tick.
  await drainGiveaway(id).catch((error) =>
    console.error("[Engagement] final collect failed:", error instanceof Error ? error.message : error)
  );
  await refreshGiveawayCounters(id);

  const { seedHex, commitment } = createCommitment();
  const moved = await prisma.giveaway.updateMany({
    where: { id, workspaceId, status: "ACTIVE" },
    data: { status: "CLOSED", seedCommitment: commitment, seedEncrypted: encryptToken(seedHex), committedAt: new Date() },
  });
  if (moved.count === 0) throw conflict("Giveaway allaqachon yopilgan — sahifani yangilang");

  const updated = await loadGiveaway(workspaceId, id);
  await forgetEngagementGate(giveaway.instagramAccountId);
  const eligible = await prisma.giveawayEntry.findMany({ where: { giveawayId: id, status: "ELIGIBLE" }, select: { igUserId: true } });
  return {
    giveaway: updated,
    commitment,
    entrantsHash: hashEntrants(eligible),
    entrantsCount: eligible.length,
    pendingExcluded: await countPendingExcluded(id),
  };
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

async function runDraw(tx: Tx, giveaway: { id: string; workspaceId: string; winnersCount: number; backupCount: number }, seedHex: string, commitment: string, sequence: number) {
  const eligible = await tx.giveawayEntry.findMany({
    where: { giveawayId: giveaway.id, status: "ELIGIBLE" },
    select: { id: true, igUserId: true },
  });
  if (eligible.length === 0) throw unprocessable("Munosib ishtirokchi yo'q — qur'a o'tkazib bo'lmaydi");

  const result = drawWinners({ seedHex, entrants: eligible, winners: giveaway.winnersCount, backups: giveaway.backupCount });
  const draw = await tx.giveawayDraw.create({
    data: {
      giveawayId: giveaway.id,
      workspaceId: giveaway.workspaceId,
      sequence,
      algorithm: result.algorithm,
      seedCommitment: commitment,
      seedRevealed: seedHex,
      entrantsHash: result.entrantsHash,
      entrantsCount: eligible.length,
      winnersCount: result.winnerIds.length,
      winnerEntryIds: result.winnerIds,
      backupEntryIds: result.backupIds,
      verification: result.verification,
      status: "DRAWN",
    },
  });
  await tx.giveawayEntry.updateMany({ where: { id: { in: result.winnerIds } }, data: { status: "WINNER" } });
  await tx.giveaway.update({ where: { id: giveaway.id }, data: { status: "DRAWN" } });
  return draw;
}

async function lastSequence(giveawayId: string): Promise<number> {
  const draws = await prisma.giveawayDraw.findMany({ where: { giveawayId }, orderBy: { sequence: "desc" }, take: 1 });
  return draws[0]?.sequence ?? 0;
}

/** Draw the winners of a CLOSED (committed) giveaway: sequence 1. */
export async function drawGiveaway(workspaceId: string, id: string) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status === "DRAWN") throw conflict("Qur'a allaqachon o'tkazilgan");
  if (giveaway.status !== "CLOSED" || !giveaway.seedEncrypted || !giveaway.seedCommitment) {
    throw conflict("Avval giveaway'ni yoping (commitment e'lon qilinadi)");
  }
  const seedHex = decryptToken(giveaway.seedEncrypted);
  if (commitmentOf(seedHex) !== giveaway.seedCommitment) throw new EngagementServiceError(500, "Seed commitment'ga mos kelmaydi");

  const sequence = (await lastSequence(id)) + 1;
  const pendingExcluded = await countPendingExcluded(id);
  const draw = await prisma
    .$transaction((tx) => runDraw(tx, giveaway, seedHex, giveaway.seedCommitment!, sequence))
    .catch(mapSequenceClash);
  await refreshGiveawayCounters(id);
  return { ...draw, pendingExcluded };
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

/** The owner accepts the result; nothing is announced before this. */
export async function confirmDraw(workspaceId: string, id: string, sequence: number, userId: string | null) {
  const draw = await prisma.giveawayDraw.findFirst({ where: { giveawayId: id, workspaceId, sequence } });
  if (!draw) throw notFound("Qur'a topilmadi");
  if (draw.status === "VOIDED") throw conflict("Bu qur'a bekor qilingan — yangisini tasdiqlang");
  if (draw.status === "CONFIRMED") return draw;
  // Only a DRAWN sequence can be confirmed: a concurrent void must not flip back.
  const moved = await prisma.giveawayDraw.updateMany({
    where: { id: draw.id, status: "DRAWN" },
    data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedByUserId: userId },
  });
  const fresh = await prisma.giveawayDraw.findFirst({ where: { id: draw.id } });
  if (moved.count === 0) {
    if (fresh?.status === "CONFIRMED") return fresh;
    throw conflict("Bu qur'a bekor qilingan — yangisini tasdiqlang");
  }
  return fresh!;
}

// ─── Disqualify / re-draw ─────────────────────────────────────────────────────

/**
 * Disqualify an entry. A winner of the current draw VOIDs it and a new
 * sequence is drawn over the remaining eligible entrants with a NEW
 * commitment (the old seed stays revealed on the voided sequence); the owner
 * confirms the new draw again.
 */
export async function disqualifyEntry(workspaceId: string, id: string, entryId: string, userId: string | null, reason: string) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status !== "CLOSED" && giveaway.status !== "DRAWN") {
    throw conflict("Diskvalifikatsiya faqat yopilgan giveaway'da mumkin");
  }
  const entry = await prisma.giveawayEntry.findFirst({ where: { id: entryId, giveawayId: id } });
  if (!entry) throw notFound("Ishtirokchi topilmadi");
  if (entry.status === "DISQUALIFIED") throw conflict("Ishtirokchi allaqachon diskvalifikatsiya qilingan");
  const cleanReason = reason.trim();
  if (!cleanReason) throw unprocessable("Diskvalifikatsiya sababini yozing");

  const current = (await prisma.giveawayDraw.findMany({ where: { giveawayId: id }, orderBy: { sequence: "desc" } })).find(
    (draw) => draw.status !== "VOIDED"
  );
  const wasWinner = entry.status === "WINNER" && Boolean(current) && giveaway.status === "DRAWN";
  const now = new Date();
  const checks = {
    ...(entry.checks && typeof entry.checks === "object" ? (entry.checks as Record<string, unknown>) : {}),
    draw: { disqualifiedAfterSeq: current?.sequence ?? 0 },
  } as Prisma.InputJsonValue;

  return prisma.$transaction(async (tx) => {
    await tx.giveawayEntry.update({
      where: { id: entryId },
      data: { status: "DISQUALIFIED", disqualifiedAt: now, disqualifiedBy: userId, disqualifyReason: cleanReason, checks },
    });
    if (!wasWinner || !current) return { redrawn: false as const, draw: null };

    await tx.giveawayDraw.update({
      where: { id: current.id },
      data: { status: "VOIDED", voidedAt: now, voidReason: `Diskvalifikatsiya: ${cleanReason}`.slice(0, 500) },
    });
    // The voided sequence's winners go back into the pool (the disqualified one is already out).
    await tx.giveawayEntry.updateMany({ where: { giveawayId: id, status: "WINNER" }, data: { status: "ELIGIBLE" } });

    const { seedHex, commitment } = createCommitment();
    await tx.giveaway.update({
      where: { id },
      data: { status: "CLOSED", seedCommitment: commitment, seedEncrypted: encryptToken(seedHex), committedAt: now },
    });
    const draw = await runDraw(tx, giveaway, seedHex, commitment, current.sequence + 1);
    return { redrawn: true as const, draw };
  }).catch(mapSequenceClash).then(async (result) => {
    await refreshGiveawayCounters(id);
    return result;
  });
}

// ─── Manual review of PENDING_CHECK ───────────────────────────────────────────

export async function markEntry(
  workspaceId: string,
  id: string,
  entryId: string,
  status: "ELIGIBLE" | "INELIGIBLE",
  userId: string | null,
  reason?: string | null
) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status !== "ACTIVE" && giveaway.status !== "CLOSED") throw conflict("Qur'adan keyin ishtirokchi holatini o'zgartirib bo'lmaydi");
  const entry = await prisma.giveawayEntry.findFirst({ where: { id: entryId, giveawayId: id } });
  if (!entry) throw notFound("Ishtirokchi topilmadi");
  if (entry.status !== "PENDING_CHECK") throw conflict("Faqat tekshiruv kutayotgan ishtirokchini qo'lda hal qilish mumkin");

  const updated = await prisma.giveawayEntry.update({
    where: { id: entryId },
    data: {
      status,
      ineligibleReason: status === "INELIGIBLE" ? (reason?.trim() || "Qo'lda rad etildi") : null,
      checks: manualChecks(entry.checks, { status, by: userId, at: new Date().toISOString(), reason: reason?.trim() || null }),
    },
  });
  await refreshGiveawayCounters(id);
  return updated;
}

/**
 * One click: every entry still waiting for a follow verdict (UNVERIFIABLE, or
 * never checked — NOT_CHECKED would otherwise be stranded at close) gets the
 * same verdict. PENDING_CHECK only ever comes from the follow rule, so the
 * other rules already passed. Owner-decided entries are left alone and are
 * not counted: `count` is the number of entries actually changed.
 */
export async function resolveUnverifiable(
  workspaceId: string,
  id: string,
  status: "ELIGIBLE" | "INELIGIBLE" = "ELIGIBLE",
  userId: string | null = null
): Promise<{ count: number }> {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status !== "ACTIVE" && giveaway.status !== "CLOSED") throw conflict("Qur'adan keyin ishtirokchi holatini o'zgartirib bo'lmaydi");
  const pending = await prisma.giveawayEntry.findMany({
    where: { giveawayId: id, status: "PENDING_CHECK", followResult: { in: ["UNVERIFIABLE", "NOT_CHECKED"] } },
  });
  const at = new Date().toISOString();
  let count = 0;
  for (const entry of pending) {
    if (isManualEntry(entry)) continue;
    const changed = await prisma.giveawayEntry.updateMany({
      where: { id: entry.id, status: "PENDING_CHECK" },
      data: {
        status,
        ineligibleReason:
          status === "INELIGIBLE" ? (entry.followResult === "NOT_CHECKED" ? "Obuna tekshirilmadi" : "Obunani tasdiqlab bo'lmadi") : null,
        checks: manualChecks(entry.checks, { status, by: userId, at, reason: "Tasdiqlab bo'lmaganlar ommaviy hal qilindi" }),
      },
    });
    count += changed.count;
  }
  await refreshGiveawayCounters(id);
  return { count };
}

// ─── Archive ──────────────────────────────────────────────────────────────────

export async function archiveGiveaway(workspaceId: string, id: string) {
  const giveaway = await loadGiveaway(workspaceId, id);
  if (giveaway.status === "ACTIVE") throw conflict("Faol giveaway'ni avval yoping");
  if (giveaway.status === "ARCHIVED") return giveaway;
  const moved = await prisma.giveaway.updateMany({
    where: { id, workspaceId, status: { in: ["DRAFT", "CLOSED", "DRAWN"] } },
    data: { status: "ARCHIVED" },
  });
  const updated = await loadGiveaway(workspaceId, id);
  if (moved.count === 0 && updated.status !== "ARCHIVED") throw conflict("Giveaway holati o'zgargan — sahifani yangilang");
  await forgetEngagementGate(giveaway.instagramAccountId);
  return updated;
}
