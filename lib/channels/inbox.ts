/**
 * Inbox of the vault channels (Facebook, Threads, YouTube): normalised
 * InboundEvents land in ChannelMessage (the table Telegram already uses),
 * a person answers from the panel, or auto-reply rules do (auto-reply.ts).
 * JavobAI (Instagram) itself stays Instagram-only.
 *
 *   accountRef  ChannelCredential.id
 *   chatId      ChannelCredential.id too: one Page connected to two
 *               workspaces gives each its own row under the unique key
 *   threadRef   post / video id (comments), sender id (Messenger)
 *
 * Replies: a comment gets a public reply or, where the channel has one, a
 * private reply (policy.ts: once, 7 days); a DM only inside the 24 h window.
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { usableCredentials } from "./access";
import { sendDmInWindow, sendPrivateReply } from "./policy";
import { adapterFor } from "./registry";
import { ChannelError, type ChannelId, type InboundEvent } from "./types";
import { pollYoutubeComments } from "./youtube";

const CHANNEL_NAME: Partial<Record<ChannelId, string>> = { facebook: "Facebook", threads: "Threads", youtube: "YouTube" };
const KIND_LABEL: Record<string, string> = { comment: "komment", reply: "javob", mention: "eslatish", dm: "xabar", postback: "tugma" };
const COMMENT_KINDS = new Set(["comment", "reply", "mention"]);
export const YOUTUBE_POLL_EVERY_SEC = 15 * 60;

/** Store events for every workspace that has this account connected. Returns new rows. */
export async function ingestChannelEvents(events: InboundEvent[]): Promise<number> {
  let created = 0;
  for (const event of events) {
    const creds = await prisma.channelCredential.findMany({
      where: { channel: event.channel, externalAccountId: event.accountId, status: { in: ["ACTIVE", "EXPIRING"] }, ...(event.tenantId ? { workspaceId: event.tenantId } : {}) },
      select: { id: true, workspaceId: true, label: true },
    });
    for (const cred of creds) {
      try {
        await prisma.channelMessage.create({
          data: {
            workspaceId: cred.workspaceId,
            channel: event.channel,
            accountRef: cred.id,
            kind: event.kind,
            chatId: cred.id,
            threadRef: event.threadId ?? event.externalId,
            externalId: event.externalId,
            direction: "IN",
            authorRef: event.author.externalId || null,
            authorName: event.author.name ?? event.author.username ?? null,
            text: event.text.slice(0, 4000),
            replyToExternalId: event.parentId ?? null,
            createdAt: event.createdAt,
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") continue; // a redelivery
        throw error;
      }
      created++;
      const name = CHANNEL_NAME[event.channel] ?? event.channel;
      const who = event.author.name ?? event.author.username ?? "Mijoz";
      await notifyWorkspaceChats(cred.workspaceId, `💬 <b>${esc(name)}: yangi ${esc(KIND_LABEL[event.kind] ?? event.kind)}</b>\n${esc(cred.label ?? "")}\n<b>${esc(who)}:</b> ${esc(event.text.slice(0, 300))}\nPanelda javob bering.`).catch(() => 0);
    }
  }
  return created;
}

export async function listChannelInbox(workspaceId: string, channel?: ChannelId, take = 100) {
  return prisma.channelMessage.findMany({
    where: { workspaceId, channel: channel ? channel : { in: ["facebook", "threads", "youtube"] }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export type ReplyMode = "public" | "private" | "dm";

/** Answer an inbox message from the panel; the answer is stored as an OUT row. */
export async function replyToInboxMessage(workspaceId: string, messageId: string, text: string, mode: ReplyMode, userId: string | null, now = new Date()) {
  const message = await prisma.channelMessage.findFirst({ where: { id: messageId, workspaceId, direction: "IN" } });
  if (!message) throw new ChannelError("invalid", "Xabar topilmadi");
  const body = text.trim();
  if (!body) throw new ChannelError("invalid", "Javob matni bo'sh");

  let sent: { externalId: string };
  if (message.kind === "dm" || message.kind === "postback") {
    if (mode !== "dm") throw new ChannelError("invalid", "Shaxsiy xabarga faqat DM bilan javob beriladi");
    const last = await prisma.channelMessage.findFirst({
      where: { workspaceId, accountRef: message.accountRef, threadRef: message.threadRef, direction: "IN", kind: { in: ["dm", "postback"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    sent = await sendDmInWindow({ workspaceId, credentialId: message.accountRef, recipientId: message.threadRef, text: body, lastInboundAt: last?.createdAt ?? null, now });
  } else if (COMMENT_KINDS.has(message.kind)) {
    if (mode === "private") {
      sent = await sendPrivateReply({ workspaceId, credentialId: message.accountRef, commentId: message.externalId, commentAt: message.createdAt, text: body, now });
    } else if (mode === "public") {
      const creds = await usableCredentials(workspaceId, message.accountRef, now);
      const adapter = adapterFor(creds.channel);
      if (!adapter) throw new ChannelError("not_supported", `${creds.channel} adapteri yo'q`);
      sent = await adapter.replyComment(creds, message.externalId, body);
    } else {
      throw new ChannelError("invalid", "Kommentga ochiq yoki shaxsiy javob beriladi");
    }
  } else {
    throw new ChannelError("not_supported", "Bu turdagi xabarga javob berilmaydi");
  }

  return prisma.channelMessage.create({
    data: {
      workspaceId,
      channel: message.channel,
      accountRef: message.accountRef,
      kind: mode === "private" ? "dm" : message.kind,
      chatId: message.chatId,
      threadRef: mode === "private" ? message.authorRef ?? message.threadRef : message.threadRef,
      externalId: sent.externalId,
      direction: "OUT",
      text: body,
      replyToExternalId: message.externalId,
      sentByUserId: userId,
    },
  });
}

export async function hideInboxComment(workspaceId: string, messageId: string, hide: boolean, now = new Date()): Promise<void> {
  const message = await prisma.channelMessage.findFirst({ where: { id: messageId, workspaceId, direction: "IN" } });
  if (!message || !COMMENT_KINDS.has(message.kind)) throw new ChannelError("invalid", "Komment topilmadi");
  const creds = await usableCredentials(workspaceId, message.accountRef, now);
  const adapter = adapterFor(creds.channel);
  if (!adapter || !adapter.capabilities().supports_hide) throw new ChannelError("not_supported", "Bu kanalda kommentni yashirib bo'lmaydi");
  await adapter.hideComment(creds, message.externalId, hide);
}

// ─── YouTube comment polling (no webhooks) ─────────────────────────────────────

export interface PollSummary {
  polled: number;
  created: number;
  failed: number;
}

/** From the content sweep each minute; every channel is read at most every 15 min. */
export async function pollYoutubeInbox(now = new Date()): Promise<PollSummary> {
  const summary: PollSummary = { polled: 0, created: 0, failed: 0 };
  const rows = await prisma.channelCredential.findMany({
    where: { channel: "youtube", status: { in: ["ACTIVE", "EXPIRING"] } },
    select: { id: true, workspaceId: true, pollCursor: true },
    take: 200,
  });
  for (const row of rows) {
    try {
      const gate = await getRedisConnection().set(`yt:poll:${row.id}`, "1", "EX", YOUTUBE_POLL_EVERY_SEC, "NX");
      if (gate !== "OK") continue;
    } catch {
      continue; // without Redis the 15-min spacing cannot be kept: skip, quota matters more
    }
    summary.polled++;
    try {
      const creds = await usableCredentials(row.workspaceId, row.id, now);
      const events = await pollYoutubeComments(creds, row.pollCursor);
      // First run: start from now, the existing comments are history.
      if (row.pollCursor) summary.created += await ingestChannelEvents(events.map((e) => ({ ...e, tenantId: row.workspaceId })));
      const newest = events.reduce<Date | null>((max, e) => (!max || e.createdAt > max ? e.createdAt : max), null);
      await prisma.channelCredential.update({ where: { id: row.id }, data: { pollCursor: newest && (!row.pollCursor || newest > row.pollCursor) ? newest : row.pollCursor ?? now } });
    } catch (error) {
      summary.failed++;
      console.warn("[channels] youtube poll failed:", error instanceof Error ? error.message : error);
    }
  }
  return summary;
}
