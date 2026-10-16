/**
 * Giveaway exports, workspace scoped, capped at EXPORT_ROW_CAP rows:
 *   exportEntriesCsv  one row per entry (spreadsheet-safe cells)
 *   exportDrawRecord  the publishable draw record: commitment, revealed seed,
 *                     verification string, winners and the sorted entrant list
 *                     anyone can re-run the draw from
 */

import { prisma } from "@/lib/db/client";
import { csvCell } from "@/lib/leads/query";
import { EXPORT_ROW_CAP } from "../config";
import { notFound } from "../errors";
import { countChangesAfterCommit, entrantsOfSequence } from "./verify";

const ENTRY_COLUMNS = [
  "igUserId",
  "username",
  "status",
  "sabab",
  "obuna",
  "izohlar",
  "belgilangan",
  "story",
  "birinchi_izoh",
  "izoh_vaqti",
] as const;

export async function exportEntriesCsv(workspaceId: string, giveawayId: string): Promise<string> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId }, select: { id: true } });
  if (!giveaway) throw notFound("Giveaway topilmadi");

  const entries = await prisma.giveawayEntry.findMany({
    where: { giveawayId, workspaceId },
    orderBy: [{ firstCommentAt: "asc" }, { id: "asc" }],
    take: EXPORT_ROW_CAP,
  });
  const lines = [ENTRY_COLUMNS.join(",")];
  for (const entry of entries) {
    lines.push(
      [
        entry.igUserId,
        entry.username ? `@${entry.username}` : "",
        entry.status,
        entry.ineligibleReason ?? entry.disqualifyReason ?? "",
        entry.followResult,
        entry.commentCount,
        entry.taggedUsernames.map((h: string) => `@${h}`).join(" "),
        entry.mentionedAt ? "ha" : "yo'q",
        entry.firstCommentText,
        entry.firstCommentAt.toISOString(),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export async function exportDrawRecord(workspaceId: string, giveawayId: string, sequence: number): Promise<string> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId }, select: { name: true, mediaId: true, committedAt: true } });
  if (!giveaway) throw notFound("Giveaway topilmadi");
  const draw = await prisma.giveawayDraw.findFirst({ where: { giveawayId, workspaceId, sequence } });
  if (!draw) throw notFound("Qur'a topilmadi");

  const entries = await prisma.giveawayEntry.findMany({
    where: { giveawayId, workspaceId },
    select: { id: true, igUserId: true, username: true, status: true, checks: true },
  });
  const allDraws = await prisma.giveawayDraw.findMany({ where: { giveawayId, workspaceId }, orderBy: { sequence: "asc" } });
  const entrants = entrantsOfSequence(entries, sequence).sort((a, b) => (a.igUserId < b.igUserId ? -1 : a.igUserId > b.igUserId ? 1 : 0));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const label = (id: string) => {
    const entry = byId.get(id);
    return entry ? `${entry.igUserId}${entry.username ? ` (@${entry.username})` : ""}` : id;
  };

  const listed = entrants.slice(0, EXPORT_ROW_CAP);
  return [
    `Giveaway: ${giveaway.name}`,
    `Post: ${giveaway.mediaId}`,
    `Qur'a #${draw.sequence} — holat: ${draw.status}${draw.voidReason ? ` (${draw.voidReason})` : ""}`,
    `O'tkazilgan vaqt: ${draw.drawnAt.toISOString()}`,
    `Algoritm: ${draw.algorithm}`,
    `Commitment (sha256 of seed text): ${draw.seedCommitment}`,
    `Seed (ochilgan): ${draw.seedRevealed}`,
    `Ishtirokchilar: ${draw.entrantsCount}, hash: ${draw.entrantsHash}`,
    `Tekshirish satri: ${draw.verification}`,
    `O'zgarishlar commitdan keyin: ${countChangesAfterCommit(entries, giveaway.committedAt)}`,
    `G'oliblar: ${draw.winnerEntryIds.map(label).join(", ") || "-"}`,
    `Zaxira: ${draw.backupEntryIds.map(label).join(", ") || "-"}`,
    "",
    "Barcha qur'alar (hash bilan):",
    ...allDraws.map(
      (d) =>
        `#${d.sequence} ${d.status} — ishtirokchilar: ${d.entrantsCount}, hash: ${d.entrantsHash}${d.voidReason ? ` — bekor qilish sababi: ${d.voidReason}` : ""}`
    ),
    "",
    "Tekshirish: 1) sha256(seed matni) = commitment; 2) ishtirokchilar igUserId bo'yicha saralanadi, hash = sha256(ro'yxat, \\n bilan);",
    "3) HMAC-SHA256(seed baytlari, '<hash>:<hisoblagich>') oqimi, rejection sampling, Fisher-Yates; birinchi N ta g'olib, keyingi M ta zaxira.",
    "",
    `Ishtirokchilar ro'yxati (igUserId bo'yicha saralangan${entrants.length > listed.length ? `, birinchi ${listed.length} tasi` : ""}):`,
    ...listed.map((e) => e.igUserId),
    "",
  ].join("\n");
}
