/**
 * Telegram channel (audit 2026-10-26, T3): the platform bot as a channel
 * admin, the discussion group under it, channel Direct Messages (Bot API 9.2)
 * and Telegram Business.
 *
 *   my_chat_member     the bot made admin of a channel → connected only when
 *                      update.from is a linked TelegramUser who may manage a
 *                      workspace; anyone else and the bot leaves the channel
 *                      (a stranger cannot plant their channel in a tenant)
 *   message            discussion-group comments under a post, channel DMs →
 *                      ChannelMessage (the inbox) + a manager alert
 *   business_*         connections of the owner's own account; messages are
 *                      stored, answers go out only while can_reply is true
 *
 * Telegram is the source of the facts (rights, linked chat); the database is
 * a cache refreshed on every my_chat_member.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { canManageWorkspace } from "@/lib/workspace-roles";
import {
  TelegramApiError,
  esc,
  getBotToken,
  getChat,
  getChatMember,
  leaveChat,
  sendMessage,
  withFloodRetry,
  type TgChatMember,
} from "./api";
import { notifyWorkspaceChats } from "./notify";

// ─── Update shapes (only what we read) ─────────────────────────────────────────

export interface TgChannelChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  is_direct_messages?: boolean;
}

export interface TgChannelMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  sender_chat?: { id: number; title?: string };
  chat: TgChannelChat;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_automatic_forward?: boolean;
  reply_to_message?: { message_id: number; is_automatic_forward?: boolean };
  direct_messages_topic?: { topic_id: number; user?: { id: number; first_name?: string; username?: string } };
  business_connection_id?: string;
  date?: number;
}

export interface TgMyChatMember {
  chat: TgChannelChat;
  from: { id: number };
  new_chat_member: TgChatMember;
  old_chat_member?: TgChatMember;
}

export interface TgBusinessConnection {
  id: string;
  user: { id: number; first_name?: string; username?: string };
  user_chat_id: number;
  is_enabled: boolean;
  /** Bot API ≤ 8.3; 9.0+ moved it into rights.can_reply. */
  can_reply?: boolean;
  rights?: { can_reply?: boolean; [key: string]: unknown };
}

export interface TgDeletedBusinessMessages {
  business_connection_id: string;
  chat: { id: number };
  message_ids: number[];
}

/** The rights a channel needs; the first three are required to publish, edit and delete. */
export const REQUIRED_CHANNEL_RIGHTS = ["can_post_messages", "can_edit_messages", "can_delete_messages", "can_manage_direct_messages"] as const;
const PUBLISH_RIGHTS = new Set(["can_post_messages", "can_edit_messages", "can_delete_messages"]);

export const RIGHT_LABELS: Record<string, string> = {
  can_post_messages: "Xabar joylash",
  can_edit_messages: "Xabarlarni tahrirlash",
  can_delete_messages: "Xabarlarni o'chirish",
  can_manage_direct_messages: "Kanal DM'larini boshqarish",
};

const ALERT_THROTTLE_SEC = 30 * 60;
/** Telegram allows about 20 messages a minute into one group / channel. */
export const CHAT_SENDS_PER_MINUTE = 20;

/** Per-chat send budget (T3 "kanal va guruh bo'yicha navbat chegarasi"); no Redis → allowed. */
export async function takeChatSlot(chatId: string, perMinute = CHAT_SENDS_PER_MINUTE): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const key = `tgch:rate:${chatId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 90);
    return count <= perMinute;
  } catch {
    return true;
  }
}

export function botIdFromToken(): number | null {
  try {
    const id = Number(getBotToken().split(":")[0]);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function missingRightsOf(member: TgChatMember): string[] {
  if (member.status === "creator") return [];
  if (member.status !== "administrator") return [...REQUIRED_CHANNEL_RIGHTS];
  return REQUIRED_CHANNEL_RIGHTS.filter((right) => member[right] !== true);
}

function rightsJson(member: TgChatMember): Prisma.InputJsonValue {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(member)) if (key.startsWith("can_") && typeof value === "boolean") out[key] = value;
  return out;
}

/** The SocialAuto workspace behind a Telegram user, only when they may manage it. */
async function managingWorkspace(tgUserId: string): Promise<string | null> {
  const link = await prisma.telegramUser.findUnique({ where: { tgUserId } });
  if (!link) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: link.workspaceId, userId: link.userId } },
  });
  return member && canManageWorkspace(member.role) ? link.workspaceId : null;
}

async function tellUser(tgUserId: number | string, text: string) {
  await sendMessage(tgUserId, text).catch(() => null); // they may never have opened the bot
}

function rightsText(missing: string[]): string {
  return missing.map((right) => `• ${RIGHT_LABELS[right] ?? right}`).join("\n");
}

// ─── my_chat_member ────────────────────────────────────────────────────────────

export type ChannelMemberOutcome = "connected" | "updated" | "left_foreign" | "removed" | "discussion" | "ignored";

export async function handleChannelMembership(update: TgMyChatMember): Promise<ChannelMemberOutcome> {
  const chat = update.chat;
  const chatId = String(chat.id);
  const status = update.new_chat_member.status;
  const gone = status === "left" || status === "kicked";

  if (chat.type !== "channel") return handleDiscussionMembership(chatId, update);

  const existing = await prisma.telegramChannel.findUnique({ where: { chatId } });
  if (gone) {
    if (!existing) return "ignored";
    await prisma.telegramChannel.update({ where: { id: existing.id }, data: { status: "REMOVED", discussionReady: false } });
    await notifyWorkspaceChats(existing.workspaceId, `⚠️ <b>Telegram kanal uzildi</b>\n${esc(existing.title ?? chatId)}\nBot kanaldan chiqarildi — nashr va kommentlar to'xtadi.`).catch(() => 0);
    return "removed";
  }

  const missing = missingRightsOf(update.new_chat_member);
  const channelStatus = missing.some((right) => PUBLISH_RIGHTS.has(right)) ? "MISSING_RIGHTS" : "ACTIVE";
  const ownedElsewhere = existing && existing.status !== "REMOVED";
  const fromWorkspace = await managingWorkspace(String(update.from.id));

  if (!ownedElsewhere) {
    // A new connection: only a linked manager may make it (audit risk "kanalni o'g'irlab ulash").
    if (!fromWorkspace) {
      await leaveChat(chatId).catch(() => null);
      await tellUser(
        update.from.id,
        "Kanal ulanmadi: avval SocialAuto panelidagi «Telegram ulash» tugmasi orqali botga /start yuboring, keyin botni kanalga qayta admin qiling."
      );
      return "left_foreign";
    }
    // Tariff channel count (phase 8): a new channel over the limit is not connected.
    const { assertChannelSlots, PlanLimitError } = await import("@/lib/billing/limits");
    try {
      await assertChannelSlots(fromWorkspace, 1);
    } catch (error) {
      if (!(error instanceof PlanLimitError)) throw error;
      await leaveChat(chatId).catch(() => null);
      await tellUser(update.from.id, `Kanal ulanmadi: ${error.message}.`);
      return "left_foreign";
    }
  }

  const info = await getChat(chatId).catch(() => null);
  const linkedChatId = info?.linked_chat_id ? String(info.linked_chat_id) : null;
  const discussionReady = linkedChatId ? await botIsAdmin(linkedChatId) : false;
  const data = {
    title: info?.title ?? chat.title ?? null,
    username: info?.username ?? chat.username ?? null,
    linkedChatId,
    discussionReady,
    status: channelStatus as "ACTIVE" | "MISSING_RIGHTS",
    rights: rightsJson(update.new_chat_member),
    missingRights: missing,
  };

  if (ownedElsewhere) {
    // Rights are facts about the bot: refresh them whoever changed them, never the owner.
    await prisma.telegramChannel.update({ where: { id: existing.id }, data });
    if (fromWorkspace && fromWorkspace !== existing.workspaceId) {
      await tellUser(update.from.id, "Bu kanal boshqa SocialAuto workspace'ga ulangan. Avval u yerda uzing.");
    }
    if (missing.length) await reportRights(existing.workspaceId, data.title ?? chatId, missing);
    return "updated";
  }

  await prisma.telegramChannel.upsert({
    where: { chatId },
    create: { workspaceId: fromWorkspace!, chatId, addedByTgUserId: String(update.from.id), ...data },
    update: { workspaceId: fromWorkspace!, addedByTgUserId: String(update.from.id), dmChatId: null, ...data },
  });
  const lines = [`✅ <b>Telegram kanal ulandi</b>: ${esc(data.title ?? chatId)}`];
  if (missing.length) lines.push(`\nBotga yetishmayotgan huquqlar:\n${rightsText(missing)}`);
  if (linkedChatId && !discussionReady) lines.push("\nKommentlarni olish uchun botni muhokama guruhida ham admin qiling.");
  if (!linkedChatId) lines.push("\nKanalda muhokama guruhi yo'q — kommentlar o'chiq.");
  await tellUser(update.from.id, lines.join("\n"));
  return "connected";
}

async function reportRights(workspaceId: string, title: string, missing: string[]) {
  await notifyWorkspaceChats(workspaceId, `⚠️ <b>${esc(title)}</b> kanalida botga huquq yetishmayapti:\n${rightsText(missing)}`).catch(() => 0);
}

async function botIsAdmin(chatId: string): Promise<boolean> {
  const botId = botIdFromToken();
  if (!botId) return false;
  const member = await getChatMember(chatId, botId).catch(() => null);
  return member?.status === "administrator" || member?.status === "creator";
}

/** The bot added to / removed from a group: matters only when it is a known channel's discussion group. */
async function handleDiscussionMembership(chatId: string, update: TgMyChatMember): Promise<ChannelMemberOutcome> {
  const channels = await prisma.telegramChannel.findMany({ where: { linkedChatId: chatId, status: { not: "REMOVED" } }, select: { id: true } });
  if (channels.length === 0) return "ignored";
  const ready = update.new_chat_member.status === "administrator" || update.new_chat_member.status === "creator";
  await prisma.telegramChannel.updateMany({ where: { id: { in: channels.map((c) => c.id) } }, data: { discussionReady: ready } });
  return "discussion";
}

// ─── Inbound: comments and channel DMs ─────────────────────────────────────────

function authorName(message: TgChannelMessage): string | null {
  if (message.from) {
    const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
    return message.from.username ? `@${message.from.username}` : name || null;
  }
  return message.sender_chat?.title ?? null;
}

async function storeMessage(row: Prisma.ChannelMessageUncheckedCreateInput): Promise<{ id: string } | null> {
  try {
    return await prisma.channelMessage.create({ data: row, select: { id: true } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null; // redelivery
    throw error;
  }
}

/** Once per thread per half hour: a busy comment thread is one alert, not fifty. */
async function alertOnce(workspaceId: string, key: string, text: string, messageId: string) {
  try {
    const first = await getRedisConnection().set(`tgch:alert:${key}`, "1", "EX", ALERT_THROTTLE_SEC, "NX");
    if (first !== "OK") return;
  } catch {
    // no Redis: alert anyway
  }
  await notifyWorkspaceChats(workspaceId, text, { keyboard: [[{ text: "✍️ Shu yerdan javob", callback_data: `jai:treply:${messageId}` }]] }).catch(() => 0);
}

async function channelForDmChat(chat: TgChannelChat) {
  const chatId = String(chat.id);
  const known = await prisma.telegramChannel.findUnique({ where: { dmChatId: chatId } });
  if (known) return known;
  const info = await getChat(chatId).catch(() => null);
  if (!info?.parent_chat) return null;
  const channel = await prisma.telegramChannel.findUnique({ where: { chatId: String(info.parent_chat.id) } });
  if (!channel || channel.status === "REMOVED") return null;
  return prisma.telegramChannel.update({ where: { id: channel.id }, data: { dmChatId: chatId } });
}

/**
 * A message in a discussion group or a channel DM chat. Returns true when it
 * was the channel's (stored), false when the normal bot handlers should see it
 * (commands, lead-delivery groups).
 */
export async function routeChannelMessage(message: TgChannelMessage): Promise<boolean> {
  const chat = message.chat;
  const text = (message.text ?? message.caption ?? "").trim();
  if (text.startsWith("/")) return false;

  if (chat.is_direct_messages) {
    const channel = await channelForDmChat(chat);
    if (!channel) return false;
    const topic = message.direct_messages_topic?.topic_id;
    if (!topic) return true;
    const outgoing = message.sender_chat?.id === Number(channel.chatId) || message.from?.is_bot === true;
    const stored = await storeMessage({
      workspaceId: channel.workspaceId,
      channel: "telegram",
      accountRef: channel.id,
      kind: "channel_dm",
      chatId: String(chat.id),
      threadRef: String(topic),
      externalId: String(message.message_id),
      direction: outgoing ? "OUT" : "IN",
      authorRef: message.from ? String(message.from.id) : null,
      authorName: authorName(message),
      text,
    });
    if (stored && !outgoing) {
      await alertOnce(
        channel.workspaceId,
        `dm:${chat.id}:${topic}`,
        `💬 <b>${esc(channel.title ?? "Kanal")}</b> — yangi DM\n${esc(authorName(message) ?? "Mijoz")}: ${esc(text.slice(0, 300))}`,
        stored.id
      );
    }
    return true;
  }

  if (chat.type !== "supergroup" && chat.type !== "group") return false;
  if (message.is_automatic_forward) return false; // the post's own copy in the group
  const root = message.message_thread_id ?? (message.reply_to_message?.is_automatic_forward ? message.reply_to_message.message_id : undefined);
  if (!root) return false;
  const channel = await prisma.telegramChannel.findFirst({ where: { linkedChatId: String(chat.id), status: { not: "REMOVED" } } });
  if (!channel) return false;
  const outgoing = message.sender_chat?.id === Number(channel.chatId) || message.from?.is_bot === true;
  const stored = await storeMessage({
    workspaceId: channel.workspaceId,
    channel: "telegram",
    accountRef: channel.id,
    kind: "comment",
    chatId: String(chat.id),
    threadRef: String(root),
    externalId: String(message.message_id),
    direction: outgoing ? "OUT" : "IN",
    authorRef: message.from ? String(message.from.id) : null,
    authorName: authorName(message),
    text,
    replyToExternalId: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
  });
  if (stored && !outgoing) {
    await alertOnce(
      channel.workspaceId,
      `comment:${chat.id}:${root}`,
      `💭 <b>${esc(channel.title ?? "Kanal")}</b> — post ostida komment\n${esc(authorName(message) ?? "Mijoz")}: ${esc(text.slice(0, 300))}`,
      stored.id
    );
  }
  return true;
}

/** edited_message in a discussion group / DM chat, edited_business_message. */
export async function recordEdit(message: TgChannelMessage): Promise<boolean> {
  const result = await prisma.channelMessage.updateMany({
    where: { channel: "telegram", chatId: String(message.chat.id), externalId: String(message.message_id) },
    data: { text: (message.text ?? message.caption ?? "").trim(), editedAt: new Date() },
  });
  return result.count > 0;
}

// ─── Telegram Business ─────────────────────────────────────────────────────────

export async function handleBusinessConnection(connection: TgBusinessConnection): Promise<"saved" | "updated" | "refused"> {
  const canReply = connection.rights?.can_reply ?? connection.can_reply ?? false;
  const existing = await prisma.telegramBusinessConnection.findUnique({ where: { connectionId: connection.id } });
  const rights = (connection.rights ?? { can_reply: canReply }) as Prisma.InputJsonValue;
  if (existing) {
    await prisma.telegramBusinessConnection.update({
      where: { id: existing.id },
      data: { isEnabled: connection.is_enabled, canReply, rights, userChatId: String(connection.user_chat_id) },
    });
    return "updated";
  }
  const workspaceId = await managingWorkspace(String(connection.user.id));
  if (!workspaceId) {
    await tellUser(connection.user_chat_id, "Biznes ulanish saqlanmadi: avval SocialAuto panelidagi «Telegram ulash» orqali akkauntingizni bog'lang.");
    return "refused";
  }
  await prisma.telegramBusinessConnection.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      tgUserId: String(connection.user.id),
      userChatId: String(connection.user_chat_id),
      canReply,
      isEnabled: connection.is_enabled,
      rights,
    },
  });
  if (!canReply) await tellUser(connection.user_chat_id, "Biznes rejim ulandi, lekin botga «javob berish» huquqi berilmagan — xabarlar faqat saqlanadi.");
  return "saved";
}

export async function handleBusinessMessage(message: TgChannelMessage): Promise<boolean> {
  if (!message.business_connection_id) return false;
  const connection = await prisma.telegramBusinessConnection.findUnique({ where: { connectionId: message.business_connection_id } });
  if (!connection || !connection.isEnabled) return false;
  const outgoing = message.from?.id === Number(connection.tgUserId) || message.from?.is_bot === true;
  await storeMessage({
    workspaceId: connection.workspaceId,
    channel: "telegram",
    accountRef: connection.id,
    kind: "business_dm",
    chatId: String(message.chat.id),
    threadRef: String(message.chat.id),
    externalId: String(message.message_id),
    direction: outgoing ? "OUT" : "IN",
    authorRef: message.from ? String(message.from.id) : null,
    authorName: authorName(message),
    text: (message.text ?? message.caption ?? "").trim(),
  });
  return true;
}

export async function handleDeletedBusinessMessages(update: TgDeletedBusinessMessages): Promise<number> {
  const connection = await prisma.telegramBusinessConnection.findUnique({ where: { connectionId: update.business_connection_id } });
  if (!connection) return 0;
  const result = await prisma.channelMessage.updateMany({
    where: { channel: "telegram", accountRef: connection.id, chatId: String(update.chat.id), externalId: { in: update.message_ids.map(String) } },
    data: { deletedAt: new Date() },
  });
  return result.count;
}

// ─── Replies ───────────────────────────────────────────────────────────────────

export type ReplyResult = { ok: true; id: string } | { ok: false; error: string };

/** Answer an inbox message where it came from: under the comment, into the DM topic, or as the business account. */
export async function replyToChannelMessage(workspaceId: string, messageId: string, text: string, by: string | null): Promise<ReplyResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "Matn bo'sh" };
  if (body.length > 4096) return { ok: false, error: "Matn 4096 belgidan uzun" };
  const message = await prisma.channelMessage.findFirst({ where: { id: messageId, workspaceId, channel: "telegram" } });
  if (!message) return { ok: false, error: "Xabar topilmadi" };

  let options: Parameters<typeof sendMessage>[2] = { parseMode: null };
  if (message.kind === "comment") {
    const channel = await prisma.telegramChannel.findFirst({ where: { id: message.accountRef, workspaceId } });
    if (!channel || channel.status === "REMOVED") return { ok: false, error: "Kanal uzilgan" };
    options = { ...options, replyTo: Number(message.externalId) };
  } else if (message.kind === "channel_dm") {
    const channel = await prisma.telegramChannel.findFirst({ where: { id: message.accountRef, workspaceId } });
    if (!channel || channel.status === "REMOVED") return { ok: false, error: "Kanal uzilgan" };
    if (channel.missingRights.includes("can_manage_direct_messages")) return { ok: false, error: "Botga «Kanal DM'larini boshqarish» huquqi berilmagan" };
    options = { ...options, directMessagesTopicId: Number(message.threadRef) };
  } else if (message.kind === "business_dm") {
    const connection = await prisma.telegramBusinessConnection.findFirst({ where: { id: message.accountRef, workspaceId } });
    if (!connection || !connection.isEnabled) return { ok: false, error: "Biznes ulanish o'chirilgan" };
    if (!connection.canReply) return { ok: false, error: "Biznes ulanishda «javob berish» huquqi yo'q" };
    options = { ...options, businessConnectionId: connection.connectionId };
  } else {
    return { ok: false, error: "Bu turdagi xabarga javob berib bo'lmaydi" };
  }

  if (!(await takeChatSlot(message.chatId))) return { ok: false, error: "Bu chatga daqiqalik limit tugadi — bir daqiqadan keyin urinib ko'ring" };
  try {
    const sent = await withFloodRetry(() => sendMessage(message.chatId, body, options));
    const row = await storeMessage({
      workspaceId,
      channel: "telegram",
      accountRef: message.accountRef,
      kind: message.kind,
      chatId: message.chatId,
      threadRef: message.threadRef,
      externalId: String(sent.message_id),
      direction: "OUT",
      text: body,
      replyToExternalId: message.externalId,
      sentByUserId: by,
    });
    return { ok: true, id: row?.id ?? "" };
  } catch (error) {
    if (error instanceof TelegramApiError) {
      if (error.isRateLimited) return { ok: false, error: `Telegram cheklovi: ${error.retryAfter ?? "bir necha"} soniyadan keyin urinib ko'ring` };
      return { ok: false, error: `Telegram: ${error.description}` };
    }
    throw error;
  }
}

// ─── Read models for the panel ─────────────────────────────────────────────────

export async function listTelegramChannels(workspaceId: string) {
  return prisma.telegramChannel.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
}

export async function listBusinessConnections(workspaceId: string) {
  return prisma.telegramBusinessConnection.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
}

export async function listInbox(workspaceId: string, opts: { kind?: string; take?: number } = {}) {
  return prisma.channelMessage.findMany({
    where: { workspaceId, channel: "telegram", ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 100, 200),
  });
}

/** Re-read rights and the discussion group from Telegram (the panel's "Tekshirish" button). */
export async function recheckChannel(workspaceId: string, id: string) {
  const channel = await prisma.telegramChannel.findFirst({ where: { id, workspaceId } });
  if (!channel) return null;
  const botId = botIdFromToken();
  if (!botId) return channel;
  const member = await getChatMember(channel.chatId, botId).catch((error) => (error instanceof TelegramApiError && error.isForbidden ? null : undefined));
  if (member === undefined) return channel; // transient: keep what we know
  if (member === null || member.status === "left" || member.status === "kicked") {
    return prisma.telegramChannel.update({ where: { id }, data: { status: "REMOVED", discussionReady: false } });
  }
  const missing = missingRightsOf(member);
  const info = await getChat(channel.chatId).catch(() => null);
  const linkedChatId = info?.linked_chat_id ? String(info.linked_chat_id) : channel.linkedChatId;
  return prisma.telegramChannel.update({
    where: { id },
    data: {
      status: missing.some((right) => PUBLISH_RIGHTS.has(right)) ? "MISSING_RIGHTS" : "ACTIVE",
      rights: rightsJson(member),
      missingRights: missing,
      linkedChatId,
      discussionReady: linkedChatId ? await botIsAdmin(linkedChatId) : false,
      title: info?.title ?? channel.title,
      username: info?.username ?? channel.username,
    },
  });
}

/** Disconnect: the bot leaves the channel, the row stays as history. */
export async function disconnectChannel(workspaceId: string, id: string): Promise<boolean> {
  const channel = await prisma.telegramChannel.findFirst({ where: { id, workspaceId } });
  if (!channel) return false;
  await leaveChat(channel.chatId).catch(() => null);
  await prisma.telegramChannel.update({ where: { id }, data: { status: "REMOVED", discussionReady: false } });
  return true;
}
