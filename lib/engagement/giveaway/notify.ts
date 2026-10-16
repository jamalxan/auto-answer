/**
 * Winner announcement, policy aware, only for a draw the owner CONFIRMED.
 *
 * Per winner, in draw order:
 *   - 24h window open (CrmContact.lastInboundAt or the person's newest DM-side
 *     InstagramEvent) and not opted out → one DM through sendGuarded (workspace
 *     quota + hourly cap);
 *   - otherwise (window closed, opted out, or the DM failed) → one PUBLIC reply
 *     under the winner's first comment ("@username tabriklaymiz! Direct'ga
 *     yozing"). A public reply is not a private message, so an opt-out does
 *     not block it; never a second private reply to a comment;
 *   - always one Telegram summary to the owner.
 * Claim first, then send: every attempt is a GiveawayNotification row under
 * the unique key (giveawayId, entryId, channel), inserted as PENDING BEFORE
 * the message goes out and settled to SENT / SKIPPED / FAILED afterwards. Two
 * concurrent calls (a double click, a retried job) can therefore never send
 * the same message twice; a FAILED / SKIPPED row may be claimed again, a SENT
 * one never. A PENDING row older than 10 minutes means a crash between the
 * send and the settle: whether it went out is unknown, so it is NOT resent —
 * it is logged ("noaniq — qo'lda tekshiring") and shown as such to the owner.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { isBroadcastWindowOpen } from "@/lib/crm/broadcast-policy";
import { sendCommentReply, sendDirectMessage } from "@/lib/meta/client";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { readAccessToken, sendGuarded } from "@/lib/triggers/delivery";
import { conflict, notFound } from "../errors";
import { enqueueEngagement, GIVEAWAY_NOTIFY_JOB, safeJobId } from "../queue";

export type NotifyLanguage = "uz" | "ru";

const DM_TEMPLATES: Record<NotifyLanguage, string> = {
  uz: "Tabriklaymiz, {username}! Siz «{giveaway}» giveaway g'olibisiz. Sovg'ani olish uchun shu yerga yozing.",
  ru: "Поздравляем, {username}! Вы победитель розыгрыша «{giveaway}». Напишите нам сюда, чтобы получить приз.",
};

const PUBLIC_TEMPLATES: Record<NotifyLanguage, string> = {
  uz: "{username} tabriklaymiz! Direct'ga yozing",
  ru: "{username} поздравляем! Напишите нам в Direct",
};

export function renderTemplate(template: string, vars: { username: string; giveaway: string }): string {
  // Without a username the greeting simply drops it (", {username}" / "{username} ").
  const base = vars.username ? template : template.replace(/,?\s*\{username\}\s?/g, "");
  const text = base.replace(/\{username\}/g, vars.username).replace(/\{giveaway\}/g, vars.giveaway).replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function winnerMessages(language: NotifyLanguage, username: string | null, giveawayName: string) {
  const vars = { username: username ? `@${username}` : "", giveaway: giveawayName };
  return {
    dm: renderTemplate(DM_TEMPLATES[language], vars),
    publicReply: renderTemplate(PUBLIC_TEMPLATES[language], vars),
  };
}

type Channel = "DM" | "PUBLIC_REPLY" | "TELEGRAM";
type Outcome = "SENT" | "SKIPPED" | "FAILED";

/** A PENDING claim older than this is an unknown outcome (crash after the send). */
export const STALE_PENDING_MS = 10 * 60_000;
const UNKNOWN_TEXT = "noaniq — qo'lda tekshiring";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

export interface WinnerOutcome {
  entryId: string;
  username: string | null;
  dm: Outcome | "NONE";
  publicReply: Outcome | "NONE";
  alreadyNotified: boolean;
  /** A claim of another run is in flight or its outcome is unknown: nothing was sent here. */
  uncertain?: boolean;
}

export interface NotifyResult {
  sequence: number;
  winners: WinnerOutcome[];
  telegram: Outcome | "NONE";
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function notifyWinners(workspaceId: string, giveawayId: string, sequence: number, now: Date = new Date()): Promise<NotifyResult> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId }, include: { instagramAccount: true } });
  if (!giveaway) throw notFound("Giveaway topilmadi");
  const draw = await prisma.giveawayDraw.findFirst({ where: { giveawayId, workspaceId, sequence } });
  if (!draw) throw notFound("Qur'a topilmadi");
  if (draw.status !== "CONFIRMED") throw conflict("G'oliblarni e'lon qilishdan oldin qur'ani tasdiqlang");

  const account = giveaway.instagramAccount;
  const token = readAccessToken(account);
  type Claim = { id: string } | null;
  /**
   * Take the (entry, channel) slot. null = somebody else holds it (SENT already,
   * in flight, or an unknown stale PENDING): the caller must not send.
   */
  const claim = async (entryId: string, channel: Channel, snapshot?: Record<string, unknown>): Promise<Claim> => {
    const data = { giveawayId, entryId, channel, status: "PENDING", snapshot: { sequence, ...snapshot } as Prisma.InputJsonValue };
    try {
      const row = await prisma.giveawayNotification.create({ data });
      return { id: row.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await prisma.giveawayNotification.findUnique({ where: { giveawayId_entryId_channel: { giveawayId, entryId, channel } } });
    if (!existing) return null;
    if (existing.status === "FAILED" || existing.status === "SKIPPED") {
      const won = await prisma.giveawayNotification.updateMany({
        where: { id: existing.id, status: existing.status },
        data: { status: "PENDING", reason: null, sentMessageId: null, snapshot: data.snapshot },
      });
      return won.count === 1 ? { id: existing.id } : null;
    }
    if (existing.status === "PENDING" && now.getTime() - existing.updatedAt.getTime() >= STALE_PENDING_MS) {
      console.warn(`[Engagement] notification ${existing.id} (${channel}, ${entryId}) ${UNKNOWN_TEXT}`);
    }
    return null;
  };
  const settle = async (claimed: Claim, status: Outcome, reason?: string | null, sentMessageId?: string | null) => {
    if (!claimed) return;
    await prisma.giveawayNotification.update({
      where: { id: claimed.id },
      data: { status, reason: reason ?? null, sentMessageId: sentMessageId ?? null },
    });
  };

  const entries = await prisma.giveawayEntry.findMany({ where: { giveawayId, id: { in: draw.winnerEntryIds } } });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const outcomes: WinnerOutcome[] = [];

  for (const entryId of draw.winnerEntryIds) {
    const entry = byId.get(entryId);
    if (!entry) continue;
    const outcome: WinnerOutcome = { entryId, username: entry.username, dm: "NONE", publicReply: "NONE", alreadyNotified: false };
    outcomes.push(outcome);

    const earlier = await prisma.giveawayNotification.findMany({ where: { giveawayId, entryId } });
    if (earlier.some((n) => n.status === "SENT" && (n.channel === "DM" || n.channel === "PUBLIC_REPLY"))) {
      outcome.alreadyNotified = true;
      continue;
    }

    const contact = await prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: entry.igUserId } },
    });
    const lastMessage = await prisma.instagramEvent.findFirst({
      where: { instagramAccountId: account.id, senderId: entry.igUserId, eventType: { in: ["DIRECT_MESSAGE", "STORY_REPLY"] } },
      orderBy: { timestamp: "desc" },
    });
    const times = [contact?.lastInboundAt, lastMessage?.timestamp].filter((t): t is Date => t instanceof Date);
    const lastInboundAt = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
    const windowOpen = isBroadcastWindowOpen(lastInboundAt, now);
    const optedOut = Boolean(contact?.optedOutAt);
    const language: NotifyLanguage = contact?.language === "ru" ? "ru" : "uz";
    const text = winnerMessages(language, entry.username, giveaway.name);
    const snapshot = { username: entry.username, windowOpen, optedOut };

    let delivered = false;
    let blocked = false;
    if (windowOpen && !optedOut && token.ok) {
      const claimed = await claim(entryId, "DM", snapshot);
      if (!claimed) {
        blocked = true;
      } else {
        const sent = await sendGuarded(workspaceId, account, () => sendDirectMessage(token.token, account.instagramId, entry.igUserId, text.dm));
        if (sent.ok) {
          outcome.dm = "SENT";
          delivered = true;
          await settle(claimed, "SENT", null, sent.sent.message_id ?? null);
        } else {
          outcome.dm = sent.skipped ? "SKIPPED" : "FAILED";
          await settle(claimed, outcome.dm, sent.skipped ? sent.error : sent.failure.userMessage);
        }
      }
    } else if (windowOpen && optedOut) {
      const claimed = await claim(entryId, "DM", snapshot);
      if (claimed) {
        outcome.dm = "SKIPPED";
        await settle(claimed, "SKIPPED", "Kontakt xabar olishdan voz kechgan");
      } else {
        blocked = true;
      }
    }

    // An in-flight / unknown DM claim might still reach the person: no second route.
    if (blocked) {
      outcome.uncertain = true;
      continue;
    }

    if (!delivered) {
      const claimed = await claim(entryId, "PUBLIC_REPLY", snapshot);
      if (!claimed) {
        outcome.uncertain = true;
      } else if (!entry.firstCommentId) {
        outcome.publicReply = "SKIPPED";
        await settle(claimed, "SKIPPED", "G'olibning izohi yo'q (faqat story-mention)");
      } else if (!token.ok) {
        outcome.publicReply = "FAILED";
        await settle(claimed, "FAILED", token.failure.userMessage);
      } else {
        try {
          const reply = await sendCommentReply(token.token, entry.firstCommentId, text.publicReply);
          outcome.publicReply = "SENT";
          await settle(claimed, "SENT", null, reply.id ?? null);
        } catch (error) {
          outcome.publicReply = "FAILED";
          await settle(claimed, "FAILED", errorText(error));
        }
      }
    }
  }

  // One Telegram summary per draw (pseudo entry `draw:<seq>`); a rerun does not repeat one that went out.
  const summaryKey = `draw:${sequence}`;
  let telegram: Outcome | "NONE" = "NONE";
  const summaryClaim = await claim(summaryKey, "TELEGRAM");
  if (summaryClaim) {
    const lines = outcomes.map((o, index) => {
      const via = o.alreadyNotified
        ? "avval xabar berilgan"
        : o.uncertain
          ? UNKNOWN_TEXT
          : o.dm === "SENT"
            ? "DM yuborildi"
            : o.publicReply === "SENT"
              ? "izohga javob yozildi"
              : "xabar yuborilmadi — qo'lda bog'laning";
      return `${index + 1}. ${o.username ? `@${o.username}` : o.entryId} — ${via}`;
    });
    const summary = `Giveaway «${giveaway.name}» g'oliblari (qur'a #${sequence}):\n${lines.join("\n")}`;
    try {
      const delivered = await notifyWorkspaceChats(workspaceId, summary, { parseMode: null });
      telegram = delivered > 0 ? "SENT" : "SKIPPED";
      await settle(summaryClaim, telegram, delivered > 0 ? null : "Telegram chat ulanmagan");
    } catch (error) {
      telegram = "FAILED";
      await settle(summaryClaim, "FAILED", errorText(error));
    }
  }

  return { sequence, winners: outcomes, telegram };
}

/**
 * Queue the announcement (worker "engagement" queue); without Redis it runs
 * right here. Call only after confirmDraw.
 */
export async function enqueueNotifyWinners(workspaceId: string, giveawayId: string, sequence: number): Promise<"queued" | "ran"> {
  const queued = await enqueueEngagement(
    GIVEAWAY_NOTIFY_JOB,
    { workspaceId, giveawayId, sequence },
    { jobId: safeJobId(`giveaway-notify_${giveawayId}_${sequence}_${Date.now()}`), attempts: 1 }
  );
  if (queued) return "queued";
  await notifyWinners(workspaceId, giveawayId, sequence);
  return "ran";
}
