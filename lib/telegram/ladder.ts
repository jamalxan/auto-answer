/**
 * Manager loop in Telegram (audit 2026-10-26): a COPILOT draft card is sent
 * as is, edited or dropped from the chat; a handoff alert can be answered
 * right here. After a typed answer the bot offers to propose it for the
 * knowledge base (the owner still approves every fact).
 *
 *   jai:dsend:<draftId>   send the draft
 *   jai:dedit:<draftId>   next text from this person in this chat replaces it
 *   jai:ddrop:<draftId>   drop the draft
 *   jai:reply:<convId>    next text goes to the customer as the business
 *   jai:kb:<key>          propose the last typed answer as a fact
 *   jai:treply:<msgId>    next text answers a Telegram channel comment / DM (T3)
 *
 * Every action needs a chat linked to the workspace and a presser linked to
 * a member of it: a forwarded card in a stranger's chat can do nothing.
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { randomUUID } from "node:crypto";
import { esc } from "./api";
import type { BotIO } from "./onboarding";

const AWAIT_TTL_S = 30 * 60;
const KB_TTL_S = 24 * 60 * 60;

type Awaiting =
  | { kind: "draft"; id: string; workspaceId: string }
  | { kind: "reply"; conversationId: string; workspaceId: string }
  | { kind: "tgmsg"; id: string; workspaceId: string };

function awaitKey(chatId: string, tgUserId: string) {
  return `jai:await:${chatId}:${tgUserId}`;
}

async function memberName(workspaceId: string, chatId: string, tgUserId: string): Promise<string | null> {
  const chat = await prisma.telegramChat.findFirst({ where: { chatId, active: true, integration: { workspaceId } }, select: { id: true } });
  if (!chat) return null;
  const link = await prisma.telegramUser.findUnique({ where: { tgUserId } });
  if (!link) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: link.userId } },
    select: { user: { select: { name: true, email: true } } },
  });
  if (!member) return null;
  return member.user?.name || member.user?.email || `tg:${tgUserId}`;
}

const NOT_ALLOWED = "Bu amal uchun avval botga /start yozib, SocialAuto akkauntingizni bog'lang (shu workspace a'zosi bo'lishingiz kerak).";

export async function handleLadderCallback(io: BotIO, chatId: string, tgUserId: string, data: string): Promise<boolean> {
  const [, action, id] = data.split(":");
  if (!id || !["dsend", "dedit", "ddrop", "reply", "kb", "treply"].includes(action)) return false;

  if (action === "treply") {
    const message = await prisma.channelMessage.findUnique({ where: { id }, select: { workspaceId: true, authorName: true } });
    if (!message) return void (await io.send(chatId, "Xabar topilmadi.")), true;
    if (!(await memberName(message.workspaceId, chatId, tgUserId))) return void (await io.send(chatId, NOT_ALLOWED)), true;
    const awaiting: Awaiting = { kind: "tgmsg", id, workspaceId: message.workspaceId };
    await getRedisConnection().set(awaitKey(chatId, tgUserId), JSON.stringify(awaiting), "EX", AWAIT_TTL_S);
    await io.send(chatId, `💬 ${esc(message.authorName ?? "Mijoz")}ga javobni shu chatga yozing (30 daqiqa). Bekor qilish: /bekor`);
    return true;
  }

  if (action === "kb") {
    const raw = await getRedisConnection().get(`jai:kbtext:${id}`).catch(() => null);
    if (!raw) return void (await io.send(chatId, "Bu taklifning muddati o'tgan.")), true;
    const item = JSON.parse(raw) as { workspaceId: string; instagramAccountId: string | null; text: string };
    const who = await memberName(item.workspaceId, chatId, tgUserId);
    if (!who) return void (await io.send(chatId, NOT_ALLOWED)), true;
    const { proposeManagerFact } = await import("@/lib/javobai/facts");
    await proposeManagerFact(item.workspaceId, item.instagramAccountId, item.text, who);
    await getRedisConnection().del(`jai:kbtext:${id}`).catch(() => 0);
    await io.send(chatId, "📚 Bilim bazasiga taklif qilindi. Egasi tasdiqlagach AI undan foydalanadi.");
    return true;
  }

  if (action === "reply") {
    const conversation = await prisma.conversation.findUnique({ where: { id }, select: { workspaceId: true, igUsername: true } });
    if (!conversation) return true;
    if (!(await memberName(conversation.workspaceId, chatId, tgUserId))) return void (await io.send(chatId, NOT_ALLOWED)), true;
    const awaiting: Awaiting = { kind: "reply", conversationId: id, workspaceId: conversation.workspaceId };
    await getRedisConnection().set(awaitKey(chatId, tgUserId), JSON.stringify(awaiting), "EX", AWAIT_TTL_S);
    await io.send(chatId, `💬 ${conversation.igUsername ? `@${esc(conversation.igUsername)}` : "Mijoz"}ga javobni shu chatga yozing (30 daqiqa). Bekor qilish: /bekor`);
    return true;
  }

  const draft = await prisma.aiDraft.findUnique({ where: { id }, select: { id: true, workspaceId: true, status: true } });
  if (!draft) return true;
  const who = await memberName(draft.workspaceId, chatId, tgUserId);
  if (!who) return void (await io.send(chatId, NOT_ALLOWED)), true;
  if (draft.status !== "PENDING") return void (await io.send(chatId, "Bu qoralama allaqachon ko'rib chiqilgan.")), true;

  if (action === "dsend") {
    const { sendJavobAiDraft } = await import("@/lib/javobai/runtime");
    const result = await sendJavobAiDraft(draft.workspaceId, draft.id, `tg:${who}`);
    await io.send(chatId, result.ok ? `✅ Yuborildi (${esc(who)}).` : `❌ ${esc(result.error ?? "Yuborilmadi")}`);
  } else if (action === "ddrop") {
    const { discardDraft } = await import("@/lib/javobai/ladder-service");
    await discardDraft(draft.workspaceId, draft.id, `tg:${who}`);
    await io.send(chatId, "✖ Qoralama bekor qilindi.");
  } else {
    const awaiting: Awaiting = { kind: "draft", id: draft.id, workspaceId: draft.workspaceId };
    await getRedisConnection().set(awaitKey(chatId, tgUserId), JSON.stringify(awaiting), "EX", AWAIT_TTL_S);
    await io.send(chatId, "✏️ To'g'rilangan matnni shu chatga yozing (30 daqiqa) — u mijozga yuboriladi. Bekor qilish: /bekor");
  }
  return true;
}

/** A free-text message: the answer the bot was waiting for, if any. Returns whether it was consumed. */
export async function handleLadderText(io: BotIO, chatId: string, tgUserId: string, text: string): Promise<boolean> {
  const key = awaitKey(chatId, tgUserId);
  let raw: string | null = null;
  try {
    raw = await getRedisConnection().get(key);
  } catch {
    return false; // Redis down: the message falls through to the normal handlers
  }
  if (!raw) return false;
  await getRedisConnection().del(key).catch(() => 0);
  if (/^\/bekor\b/i.test(text)) {
    await io.send(chatId, "Bekor qilindi.");
    return true;
  }
  const awaiting = JSON.parse(raw) as Awaiting;
  const who = await memberName(awaiting.workspaceId, chatId, tgUserId);
  if (!who) return void (await io.send(chatId, NOT_ALLOWED)), true;
  if (awaiting.kind === "tgmsg") {
    const { replyToChannelMessage } = await import("./channel");
    const sent = await replyToChannelMessage(awaiting.workspaceId, awaiting.id, text, `tg:${who}`);
    await io.send(chatId, sent.ok ? "✅ Telegram'da javob berildi." : `❌ ${esc(sent.error)}`);
    return true;
  }
  const runtime = await import("@/lib/javobai/runtime");
  let conversationId: string;
  let result;
  if (awaiting.kind === "draft") {
    const draft = await prisma.aiDraft.findUnique({ where: { id: awaiting.id }, select: { conversationId: true } });
    if (!draft) return true;
    conversationId = draft.conversationId;
    result = await runtime.sendJavobAiDraft(awaiting.workspaceId, awaiting.id, `tg:${who}`, text);
  } else {
    conversationId = awaiting.conversationId;
    result = await runtime.sendManagerReply(awaiting.workspaceId, awaiting.conversationId, text, `tg:${who}`);
  }
  if (!result.ok) return void (await io.send(chatId, `❌ ${esc(result.error ?? "Yuborilmadi")}`)), true;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { instagramAccountId: true } });
  const kbKey = randomUUID().replace(/-/g, "").slice(0, 20);
  await getRedisConnection()
    .set(`jai:kbtext:${kbKey}`, JSON.stringify({ workspaceId: awaiting.workspaceId, instagramAccountId: conversation?.instagramAccountId ?? null, text }), "EX", KB_TTL_S)
    .catch(() => null);
  await io.send(chatId, "✅ Mijozga yuborildi. Bu javobdagi ma'lumot boshqa mijozlarga ham to'g'rimi?", {
    keyboard: [[{ text: "📚 Bilim bazasiga taklif qilish", callback_data: `jai:kb:${kbKey}` }]],
  });
  return true;
}
