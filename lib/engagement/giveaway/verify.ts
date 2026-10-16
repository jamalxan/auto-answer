/**
 * Verification of a stored draw: rebuild the entrant list the draw ran over
 * and recompute it with the pure verifyDraw (draw.ts).
 *
 * The entrants of sequence n are the entries that were eligible when it ran:
 * ELIGIBLE or WINNER now, plus DISQUALIFIED ones that were disqualified after
 * that sequence (checks.draw.disqualifiedAfterSeq >= n; 0 = before any draw).
 */

import { prisma } from "@/lib/db/client";
import { notFound } from "../errors";
import { verifyDraw, type DrawEntrant } from "./draw";

export { verifyDraw } from "./draw";

interface EntrantRow {
  id: string;
  igUserId: string;
  status: string;
  checks: unknown;
}

export function entrantsOfSequence(entries: EntrantRow[], sequence: number): DrawEntrant[] {
  return entries
    .filter((entry) => {
      if (entry.status === "ELIGIBLE" || entry.status === "WINNER") return true;
      if (entry.status !== "DISQUALIFIED") return false;
      const after = (entry.checks as { draw?: { disqualifiedAfterSeq?: number } } | null)?.draw?.disqualifiedAfterSeq;
      return typeof after === "number" && after >= sequence;
    })
    .map((entry) => ({ id: entry.id, igUserId: entry.igUserId }));
}

/**
 * Owner decisions made after the commitment was published (markEntry /
 * resolveUnverifiable stay allowed while CLOSED): entries whose
 * `checks.manual.at` is later than `committedAt`. The record shows the number
 * so a reader knows the entrant list moved after the commit.
 */
export function countChangesAfterCommit(entries: Array<{ checks: unknown }>, committedAt: Date | null): number {
  if (!committedAt) return 0;
  let count = 0;
  for (const entry of entries) {
    const at = (entry.checks as { manual?: { at?: unknown } } | null)?.manual?.at;
    const time = typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isFinite(time) && time > committedAt.getTime()) count++;
  }
  return count;
}

export interface StoredDrawVerification {
  ok: boolean;
  /** Owner decisions on entries after the commitment was published. */
  changesAfterCommit: number;
  sequence: number;
  winnerIds: string[];
  problems: string[];
}

export async function verifyStoredDraw(workspaceId: string, giveawayId: string, sequence: number): Promise<StoredDrawVerification> {
  const draw = await prisma.giveawayDraw.findFirst({ where: { giveawayId, workspaceId, sequence } });
  if (!draw) throw notFound("Qur'a topilmadi");
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId }, select: { committedAt: true } });
  const entries = await prisma.giveawayEntry.findMany({
    where: { giveawayId, workspaceId },
    select: { id: true, igUserId: true, status: true, checks: true },
  });
  const result = verifyDraw({
    seedHex: draw.seedRevealed,
    algorithm: draw.algorithm,
    commitment: draw.seedCommitment,
    entrantsHash: draw.entrantsHash,
    entrants: entrantsOfSequence(entries, sequence),
    winners: draw.winnersCount,
    backups: draw.backupEntryIds.length,
    winnerIds: draw.winnerEntryIds,
    backupIds: draw.backupEntryIds,
  });
  return {
    ok: result.ok,
    changesAfterCommit: countChangesAfterCommit(entries, giveaway?.committedAt ?? null),
    sequence, winnerIds: result.winnerIds,
    problems: result.problems,
  };
}
