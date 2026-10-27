/**
 * Comment guard (audit 2026-10-26): under the account's own posts an
 * offensive comment is hidden, a complaint goes to the managers' Telegram.
 * Opt-in per account (config `hideOffensiveComments`, `notifyCommentComplaints`).
 *
 * Deterministic word lists (Uzbek Latin / Cyrillic, Russian): no model call
 * per comment, and the owner can see exactly why something was hidden. One
 * CommentModeration row per comment makes webhook redeliveries no-ops.
 */

import { prisma } from "@/lib/db/client";
import { instagramAdapter } from "@/lib/channels/instagram";
import { decryptToken } from "@/lib/meta/oauth";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { loadAccountConfig } from "./state";

export type CommentVerdict = "offensive" | "complaint" | "ok";

/** Stems: matched at the start of a word, so inflected forms count too; a trailing "$" means the whole word only. */
const OFFENSIVE_STEMS = [
  // Uzbek
  "jalab", "qanjiq", "sikay", "sikdim", "onangni", "itdan tarqagan", "dalba", "iflos", "tupoy",
  // Uzbek Cyrillic
  "жалаб", "қанжиқ", "сикай", "онангни", "далба", "ифлос",
  // Russian
  "хуй", "хуе", "пизд", "ебан", "ебат", "бляд", "блят", "сука$", "суки$", "мудак", "мудил", "долбо", "уебок", "гандон", "шлюх", "пидор", "пидар",
  // English
  "fuck", "shit", "bitch", "asshole",
];

const COMPLAINT_STEMS = [
  // Uzbek
  "aldad", "aldov", "aldamchi", "firibgar", "pulimni qaytar", "pulni qaytar", "yetkazilmadi", "sifatsiz", "buzuq", "buzilgan", "shikoyat", "javob bermay", "yolg'on", "yolgon",
  // Uzbek Cyrillic
  "алдад", "алдамчи", "фирибгар", "сифатсиз", "шикоят", "елғон",
  // Russian
  "обман", "мошенн", "верните деньги", "не пришл", "не пришел", "не приходит", "не доставил", "ужасн", "жалоб", "не отвечает", "не отвечаете",
];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/ё/g, "е").replace(/[’ʻʼ`‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()} `;
}

function hasStem(normalized: string, stems: string[]): string | null {
  for (const stem of stems) {
    const hit = stem.endsWith("$") ? normalized.includes(` ${stem.slice(0, -1)} `) : normalized.includes(` ${stem}`);
    if (hit) return stem.replace(/\$$/, "");
  }
  return null;
}

export function classifyComment(text: string): { verdict: CommentVerdict; matched: string | null } {
  const n = normalize(text);
  const offensive = hasStem(n, OFFENSIVE_STEMS);
  if (offensive) return { verdict: "offensive", matched: offensive };
  const complaint = hasStem(n, COMPLAINT_STEMS);
  if (complaint) return { verdict: "complaint", matched: complaint };
  return { verdict: "ok", matched: null };
}

export interface GuardInput {
  /** Instagram id of the account (webhook entry.id). */
  instagramId: string;
  commentId: string;
  text: string;
  mediaId: string;
  commenterName?: string | null;
}

/** Returns true when the comment was hidden (the caller then skips its automations). */
export async function guardComment(input: GuardInput): Promise<boolean> {
  const { verdict, matched } = classifyComment(input.text);
  if (verdict === "ok") return false;
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: input.instagramId },
    select: { id: true, workspaceId: true, username: true, accessToken: true, instagramId: true },
  });
  if (!account) return false;
  const config = await loadAccountConfig(account.id);
  if (verdict === "offensive" && !config.hideOffensiveComments) return false;
  if (verdict === "complaint" && !config.notifyCommentComplaints) return false;

  // Claim the comment: a redelivered webhook finds the row and stops here.
  try {
    await prisma.commentModeration.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        commentId: input.commentId,
        mediaId: input.mediaId,
        text: input.text.slice(0, 2000),
        verdict,
        action: "none",
      },
    });
  } catch {
    const prior = await prisma.commentModeration.findUnique({ where: { commentId: input.commentId }, select: { action: true } });
    return prior?.action === "hidden";
  }

  const who = input.commenterName ? `@${input.commenterName}` : "Kimdir";
  if (verdict === "offensive") {
    let action = "hidden";
    let error: string | null = null;
    try {
      if (!account.accessToken) throw new Error("token yo'q");
      await instagramAdapter.hideComment({ accessToken: decryptToken(account.accessToken), externalAccountId: account.instagramId }, input.commentId, true);
    } catch (e) {
      action = "failed";
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    await prisma.commentModeration.update({ where: { commentId: input.commentId }, data: { action, error } });
    const title = action === "hidden" ? "🙈 <b>Haqoratli komment yashirildi</b>" : "⚠️ <b>Haqoratli komment — yashirib bo'lmadi</b>";
    await notifyWorkspaceChats(
      account.workspaceId,
      `${title}\n@${esc(account.username ?? "")} · ${esc(who)}\n<i>${esc(input.text.slice(0, 300))}</i>\nSabab: «${esc(matched ?? "")}»`
    ).catch(() => 0);
    return action === "hidden";
  }

  const sent = await notifyWorkspaceChats(
    account.workspaceId,
    `😠 <b>Kommentda shikoyat</b>\n@${esc(account.username ?? "")} · ${esc(who)}\n<i>${esc(input.text.slice(0, 500))}</i>\nIltimos, tezroq javob bering.`
  ).catch(() => 0);
  await prisma.commentModeration.update({
    where: { commentId: input.commentId },
    data: { action: sent > 0 ? "notified" : "failed", error: sent > 0 ? null : "Telegram ulanmagan" },
  });
  return false;
}

export async function listCommentModerations(workspaceId: string, take = 100) {
  return prisma.commentModeration.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take });
}
