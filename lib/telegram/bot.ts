/**
 * Telegram update router. One platform bot serves: connecting chats for lead
 * delivery, the "Bog'lanildi" button, the owner onboarding Q&A and the
 * management commands (/profil /narxlar /mahsulot /savollar /assistent /test).
 */

import { prisma } from "@/lib/db/client";
import { findProfile } from "@/lib/assistant/profile";
import { newSandboxState } from "@/lib/assistant/sandbox";
import { updateProfileFields } from "@/lib/assistant/profile-write";
import { getRedisConnection } from "@/lib/queue/client";
import { buildLeadKeyboard, buildLeadText } from "./lead-message";
import {
  TelegramApiError,
  answerCallbackQuery,
  downloadFile,
  editMessageText,
  esc,
  getBotUsername,
  getFileInfo,
  sendMessage,
} from "./api";
import { botLangFromTelegram, tr } from "./bot-text";
import {
  answersFromProfile,
  beginGapAnswer,
  getLiveSession,
  handleOnboardingCallback,
  handleOnboardingMessage,
  readFsm,
  renderProducts,
  resumeOnboarding,
  startOnboarding,
  stopTest,
  type BotIO,
  type Fsm,
  type IncomingMessage,
} from "./onboarding";
import { indexOfQuestion, questionAt, type BotLang } from "./onboarding-questions";

// ─── Telegram types (only what we read) ────────────────────────────────────────

interface TgUser {
  id: number;
  language_code?: string;
  username?: string;
  first_name?: string;
}
interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  voice?: { file_id: string; duration: number; file_size?: number; mime_type?: string };
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  location?: { latitude: number; longitude: number };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } };
}

export const defaultIo: BotIO = {
  send: (chatId, text, options) => sendMessage(chatId, text, options),
  edit: (chatId, messageId, text, options) => editMessageText(chatId, messageId, text, options),
  download: async (fileId) => {
    const info = await getFileInfo(fileId);
    if (!info.file_path) throw new Error("no file_path");
    return downloadFile(info.file_path);
  },
};

// ─── Identity & permissions ────────────────────────────────────────────────────

/** SocialAuto account behind a Telegram user, only if they may manage the workspace. */
async function resolveOwner(tgUserId: string) {
  const link = await prisma.telegramUser.findUnique({ where: { tgUserId } });
  if (!link) return { status: "unlinked" as const };
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: link.workspaceId, userId: link.userId } },
  });
  if (!member || member.role === "MEMBER") return { status: "forbidden" as const, link };
  return { status: "ok" as const, link, role: member.role };
}

function langOfLink(link: { language: string }): BotLang {
  return link.language === "ru" ? "ru" : "uz";
}

// ─── Linking chats (lead delivery) ─────────────────────────────────────────────

async function consumeCode(code: string) {
  const row = await prisma.telegramLinkCode.findUnique({ where: { code } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  // Single use, race-safe.
  const claimed = await prisma.telegramLinkCode.updateMany({
    where: { code, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1 ? row : null;
}

async function linkChat(io: BotIO, message: TgMessage, code: string, lang: BotLang) {
  const t = tr(lang);
  const row = await consumeCode(code);
  if (!row) return void (await io.send(String(message.chat.id), t.codeInvalid));

  let integration = await prisma.integration.findFirst({
    where: { workspaceId: row.workspaceId, type: "TELEGRAM" },
    orderBy: { createdAt: "asc" },
  });
  if (!integration) {
    integration = await prisma.integration.create({
      data: { workspaceId: row.workspaceId, type: "TELEGRAM", name: "Telegram" },
    });
  } else if (integration.status !== "ACTIVE") {
    integration = await prisma.integration.update({
      where: { id: integration.id },
      data: { status: "ACTIVE", lastError: null },
    });
  }

  const chatId = String(message.chat.id);
  const title =
    message.chat.title ??
    ([message.from?.first_name, message.from?.username ? `@${message.from.username}` : null].filter(Boolean).join(" ") ||
      "Telegram");
  await prisma.telegramChat.upsert({
    where: { integrationId_chatId: { integrationId: integration.id, chatId } },
    create: { integrationId: integration.id, chatId, title, type: message.chat.type, active: true },
    update: { title, type: message.chat.type, active: true },
  });

  // A private chat linked by a logged-in owner also gives them bot commands.
  if (message.chat.type === "private" && row.userId && message.from) {
    await prisma.telegramUser.upsert({
      where: { tgUserId: String(message.from.id) },
      create: { tgUserId: String(message.from.id), userId: row.userId, workspaceId: row.workspaceId, language: lang },
      update: { userId: row.userId, workspaceId: row.workspaceId },
    });
  }

  await io.send(chatId, t.chatLinked(esc(title)));
}

async function startOnboardingFromCode(io: BotIO, message: TgMessage, code: string, lang: BotLang) {
  const t = tr(lang);
  const chatId = String(message.chat.id);
  const row = await consumeCode(code);
  if (!row || !row.userId || !message.from) return void (await io.send(chatId, t.codeInvalid));

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: row.workspaceId, userId: row.userId } },
  });
  if (!member || member.role === "MEMBER") return void (await io.send(chatId, t.notAllowed));

  await prisma.telegramUser.upsert({
    where: { tgUserId: String(message.from.id) },
    create: { tgUserId: String(message.from.id), userId: row.userId, workspaceId: row.workspaceId, language: lang },
    update: { userId: row.userId, workspaceId: row.workspaceId },
  });
  await startOnboarding(io, {
    workspaceId: row.workspaceId,
    tgUserId: String(message.from.id),
    language: lang,
    igAccountId: row.igAccountId,
  });
}

// ─── Commands ──────────────────────────────────────────────────────────────────

function privateChatUrl(): string {
  const username = getBotUsername();
  return username ? `https://t.me/${username}` : "";
}

async function cmdProfile(io: BotIO, tgUserId: string, lang: BotLang, workspaceId: string) {
  const live = await getLiveSession(tgUserId);
  if (live) return resumeOnboarding(io, live.id);
  await startOnboarding(io, { workspaceId, tgUserId, language: lang });
}

async function seededSession(
  io: BotIO,
  workspaceId: string,
  tgUserId: string,
  lang: BotLang,
  fsm: Fsm,
  step: number
) {
  const t = tr(lang);
  const profile = await findProfile(workspaceId, null) ?? (await prisma.assistantProfile.findFirst({
    where: { workspaceId },
    include: { products: { orderBy: { sort: "asc" } }, faqs: { orderBy: { sort: "asc" } } },
  }));
  if (!profile) {
    await io.send(tgUserId, t.noProfile);
    return null;
  }
  await prisma.onboardingSession.updateMany({
    where: { tgUserId, status: { in: ["ACTIVE", "PAUSED"] } },
    data: { status: "ABANDONED" },
  });
  return prisma.onboardingSession.create({
    data: {
      workspaceId,
      tgUserId,
      language: lang,
      igAccountId: profile.instagramAccountId,
      step,
      answers: JSON.parse(JSON.stringify(answersFromProfile(profile))),
      fsm: JSON.parse(JSON.stringify(fsm)),
    },
  });
}

async function cmdPrices(io: BotIO, workspaceId: string, tgUserId: string, lang: BotLang) {
  const session = await seededSession(io, workspaceId, tgUserId, lang, { awaiting: "products_review", productsContext: "manage" }, indexOfQuestion("products"));
  if (!session) return;
  const products = (session.answers as { products?: never[] }).products ?? [];
  // Re-use the review screen over the live product list.
  const text = renderProducts(products, 0, tr(lang));
  await prisma.onboardingSession.update({
    where: { id: session.id },
    data: { fsm: JSON.parse(JSON.stringify({ awaiting: "products_review", productsContext: "manage", pendingProducts: products, page: 0 })) },
  });
  const t = tr(lang);
  await io.send(tgUserId, `${t.productsHeader(products.length)}\n\n${text}`, {
    keyboard: [
      [{ text: t.allCorrect, callback_data: "ob:prod_ok" }],
      [
        { text: t.fix, callback_data: "ob:prod_fix" },
        { text: t.addMore, callback_data: "ob:prod_add" },
        { text: t.deleteRow, callback_data: "ob:prod_del" },
      ],
    ],
  });
}

async function cmdProduct(io: BotIO, workspaceId: string, tgUserId: string, lang: BotLang) {
  const session = await seededSession(io, workspaceId, tgUserId, lang, { awaiting: "product_name" }, indexOfQuestion("products"));
  if (session) await io.send(tgUserId, tr(lang).productAddName);
}

async function cmdFaqs(io: BotIO, workspaceId: string, tgUserId: string, lang: BotLang) {
  const t = tr(lang);
  const session = await seededSession(io, workspaceId, tgUserId, lang, { awaiting: "faq_input", returnToSummary: true }, indexOfQuestion("faqs"));
  if (!session) return;
  const faqs = (session.answers as { faqs?: Array<{ question: string; answer: string }> }).faqs ?? [];
  const list = faqs.map((f, i) => `${i + 1}. ${esc(f.question)}\n   ${esc(f.answer)}`).join("\n");
  await io.send(tgUserId, `${t.faqHeader(faqs.length)}\n\n${list}\n\n${questionAt(indexOfQuestion("faqs"))!.text[lang]}`, {
    keyboard: [[{ text: t.done, callback_data: "ob:faq_done" }]],
  });
}

async function cmdAssistant(io: BotIO, workspaceId: string, tgUserId: string, lang: BotLang) {
  const t = tr(lang);
  const profile = await findProfile(workspaceId, null) ?? (await prisma.assistantProfile.findFirst({ where: { workspaceId }, include: { products: true, faqs: true } }));
  if (!profile) return void (await io.send(tgUserId, t.noProfile));
  const policy = { NEVER: lang === "ru" ? "цену не называем" : "narx aytilmaydi", FROM_ONLY: lang === "ru" ? "«от ...»" : "«...dan boshlab»", EXACT: lang === "ru" ? "точная цена" : "aniq narx" };
  await io.send(tgUserId, `${profile.enabled ? t.assistantOn : t.assistantOff}\n${t.pricePolicyLabel}: ${policy[profile.pricePolicy]}`, {
    keyboard: [
      [{ text: profile.enabled ? t.toggleOff : t.toggleOn, callback_data: `as:toggle:${profile.id}` }],
      [
        { text: policy.NEVER, callback_data: `as:policy:${profile.id}:NEVER` },
        { text: policy.FROM_ONLY, callback_data: `as:policy:${profile.id}:FROM_ONLY` },
        { text: policy.EXACT, callback_data: `as:policy:${profile.id}:EXACT` },
      ],
    ],
  });
}

async function cmdTest(io: BotIO, workspaceId: string, tgUserId: string, lang: BotLang) {
  const session = await seededSession(io, workspaceId, tgUserId, lang, { awaiting: "test", test: newSandboxState() }, 11);
  if (session) await io.send(tgUserId, tr(lang).testStarted);
}

// ─── Callback handlers ─────────────────────────────────────────────────────────

async function handleContacted(io: BotIO, cb: NonNullable<TgUpdate["callback_query"]>, leadId: string) {
  const chatId = cb.message ? String(cb.message.chat.id) : null;
  if (!chatId || !cb.message) return;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { instagramAccount: { select: { username: true } } },
  });
  if (!lead) return;

  // The chat must be connected to the lead's workspace.
  const chat = await prisma.telegramChat.findFirst({
    where: { chatId, active: true, integration: { workspaceId: lead.workspaceId } },
  });
  if (!chat) return void (await answerCallbackQuery(cb.id, tr("uz").notLinkedForLead));

  const link = await prisma.telegramUser.findUnique({ where: { tgUserId: String(cb.from.id) } });
  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: { contactedAt: lead.contactedAt ?? new Date(), contactedByUserId: link?.userId ?? lead.contactedByUserId },
  });
  const who = cb.from.username ? `@${cb.from.username}` : (cb.from.first_name ?? "");
  const profile = await prisma.assistantProfile.findFirst({ where: { workspaceId: lead.workspaceId }, select: { extraFieldLabel: true } });
  const text = `${buildLeadText({
    id: updated.id,
    igAccountUsername: lead.instagramAccount.username,
    name: updated.name,
    igUsername: updated.igUsername,
    phoneE164: updated.phoneE164,
    productInterest: updated.productInterest,
    extraField: updated.extraField,
    extraFieldLabel: profile?.extraFieldLabel,
    source: updated.source,
    campaignName: updated.campaignName,
    triggerKeyword: updated.triggerKeyword,
    summary: updated.summary,
    flag: updated.flag,
    isTest: updated.isTest,
    isRepeat: updated.isRepeat,
    conversationId: updated.conversationId,
    contactedAt: updated.contactedAt,
  })} — ${esc(who)}`;
  const crm = await prisma.leadDelivery.findMany({
    where: { leadId: lead.id, status: "SENT", externalUrl: { not: null }, integration: { type: { in: ["AMOCRM", "BITRIX24"] } } },
    include: { integration: { select: { type: true } } },
  });
  await editMessageText(chatId, cb.message.message_id, text, {
    keyboard: buildLeadKeyboard(updated, crm.map((d) => ({ label: d.integration.type === "AMOCRM" ? "amoCRM" : "Bitrix24", url: d.externalUrl! }))),
  }).catch(() => {});
}

async function handleAssistantCallback(io: BotIO, tgUserId: string, parts: string[]) {
  const owner = await resolveOwner(tgUserId);
  if (owner.status !== "ok") return;
  const lang = langOfLink(owner.link);
  const [, action, profileId, value] = parts;
  const profile = await prisma.assistantProfile.findFirst({ where: { id: profileId, workspaceId: owner.link.workspaceId } });
  if (!profile) return;
  if (action === "toggle") {
    if (!profile.approvedAt && !profile.enabled) return void (await io.send(tgUserId, tr(lang).noProfile));
    await updateProfileFields(profile.id, {}, "TELEGRAM", owner.link.userId, { enabled: !profile.enabled });
    await prisma.profileChangeLog.create({ data: { profileId, source: "TELEGRAM", actorUserId: owner.link.userId, field: "enabled", oldValue: profile.enabled, newValue: !profile.enabled } });
  } else if (action === "policy" && (value === "NEVER" || value === "FROM_ONLY" || value === "EXACT")) {
    await updateProfileFields(profile.id, { pricePolicy: value }, "TELEGRAM", owner.link.userId);
  }
  await cmdAssistant(io, owner.link.workspaceId, tgUserId, lang);
}

async function handleCallback(io: BotIO, update: TgUpdate) {
  const cb = update.callback_query!;
  const data = cb.data ?? "";
  const tgUserId = String(cb.from.id);
  await answerCallbackQuery(cb.id).catch(() => {});

  if (data.startsWith("contacted:")) return handleContacted(io, cb, data.slice("contacted:".length));
  if (cb.message && cb.message.chat.type !== "private") return;

  const parts = data.split(":");
  const owner = await resolveOwner(tgUserId);
  if (owner.status !== "ok") {
    const lang = botLangFromTelegram(cb.from.language_code);
    return void (await io.send(tgUserId, owner.status === "forbidden" ? tr(lang).notAllowed : tr(lang).notLinked));
  }
  const lang = langOfLink(owner.link);

  switch (parts[0]) {
    case "ob": {
      const session = await getLiveSession(tgUserId);
      if (!session || !cb.message) return void (await io.send(tgUserId, tr(lang).noActiveSession));
      return handleOnboardingCallback(io, session.id, data, cb.message.message_id);
    }
    case "as":
      return handleAssistantCallback(io, tgUserId, parts);
    case "gap_answer":
      return beginGapAnswer(io, tgUserId, owner.link.workspaceId, lang, parts[1]);
    case "gap_ignore": {
      await prisma.knowledgeGap.updateMany({ where: { id: parts[1], workspaceId: owner.link.workspaceId }, data: { status: "IGNORED" } });
      return void (await io.send(tgUserId, tr(lang).gapIgnored));
    }
    case "price_ok": {
      await prisma.assistantProduct.updateMany({ where: { profileId: parts[1], profile: { workspaceId: owner.link.workspaceId } }, data: { priceUpdatedAt: new Date() } });
      return void (await io.send(tgUserId, tr(lang).priceThanks));
    }
    case "price_update":
      return cmdPrices(io, owner.link.workspaceId, tgUserId, lang);
    case "lang": {
      const next: BotLang = parts[1] === "ru" ? "ru" : "uz";
      await prisma.telegramUser.update({ where: { tgUserId }, data: { language: next } });
      await prisma.onboardingSession.updateMany({ where: { tgUserId, status: { in: ["ACTIVE", "PAUSED"] } }, data: { language: next } });
      return void (await io.send(tgUserId, tr(next).saved));
    }
  }
}

// ─── Messages ──────────────────────────────────────────────────────────────────

function parseStart(text: string): string | null {
  const m = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
  return m ? (m[1] ?? "") : null;
}

function command(text: string | undefined): string | null {
  const m = text?.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  return m ? m[1].toLowerCase() : null;
}

const OWNER_COMMANDS = new Set(["profil", "narxlar", "mahsulot", "savollar", "assistent", "test", "stop_test", "til"]);

async function handleMessage(io: BotIO, message: TgMessage) {
  if (!message.from) return;
  const chatId = String(message.chat.id);
  const tgUserId = String(message.from.id);
  const text = message.text?.trim();
  const baseLang = botLangFromTelegram(message.from.language_code);
  const isPrivate = message.chat.type === "private";

  const startPayload = text ? parseStart(text) : null;
  if (startPayload !== null) {
    if (startPayload.startsWith("onb_")) {
      if (!isPrivate) return void (await io.send(chatId, tr(baseLang).privateOnly));
      return startOnboardingFromCode(io, message, startPayload, baseLang);
    }
    if (startPayload) return linkChat(io, message, startPayload, baseLang);
    return void (await io.send(chatId, tr(baseLang).welcome, {
      keyboard: [[{ text: "🇺🇿 O'zbekcha", callback_data: "lang:uz" }, { text: "🇷🇺 Русский", callback_data: "lang:ru" }]],
    }));
  }

  const cmd = command(text);
  if (cmd && OWNER_COMMANDS.has(cmd)) {
    if (!isPrivate) {
      const url = privateChatUrl();
      return void (await io.send(chatId, url ? tr(baseLang).privateOnlyLink(url) : tr(baseLang).privateOnly));
    }
    const owner = await resolveOwner(tgUserId);
    if (owner.status === "unlinked") return void (await io.send(chatId, tr(baseLang).notLinked));
    if (owner.status === "forbidden") return void (await io.send(chatId, tr(langOfLink(owner.link)).notAllowed));
    const lang = langOfLink(owner.link);
    const workspaceId = owner.link.workspaceId;

    switch (cmd) {
      case "profil":
        return cmdProfile(io, tgUserId, lang, workspaceId);
      case "narxlar":
        return cmdPrices(io, workspaceId, tgUserId, lang);
      case "mahsulot":
        return cmdProduct(io, workspaceId, tgUserId, lang);
      case "savollar":
        return cmdFaqs(io, workspaceId, tgUserId, lang);
      case "assistent":
        return cmdAssistant(io, workspaceId, tgUserId, lang);
      case "test":
        return cmdTest(io, workspaceId, tgUserId, lang);
      case "til": {
        const next: BotLang = lang === "uz" ? "ru" : "uz";
        await prisma.telegramUser.update({ where: { tgUserId }, data: { language: next } });
        await prisma.onboardingSession.updateMany({ where: { tgUserId, status: { in: ["ACTIVE", "PAUSED"] } }, data: { language: next } });
        return void (await io.send(chatId, tr(next).saved));
      }
      case "stop_test": {
        const session = await getLiveSession(tgUserId);
        if (session && (readFsm(session) as Fsm).awaiting === "test") return stopTest(io, session.id);
        return;
      }
    }
    return;
  }

  // Free-form input: only meaningful in a private chat with a live session.
  if (!isPrivate) return;
  const owner = await resolveOwner(tgUserId);
  if (owner.status !== "ok") return;
  const session = await getLiveSession(tgUserId);
  if (!session || session.status === "PAUSED") return;

  const incoming: IncomingMessage = {
    chatId,
    tgUserId,
    text,
    voice: message.voice
      ? { fileId: message.voice.file_id, duration: message.voice.duration, size: message.voice.file_size, mime: message.voice.mime_type }
      : undefined,
    photo: message.photo?.length ? { fileId: message.photo[message.photo.length - 1].file_id } : undefined,
    document: message.document
      ? { fileId: message.document.file_id, name: message.document.file_name, mime: message.document.mime_type, size: message.document.file_size }
      : undefined,
    location: message.location ? { lat: message.location.latitude, lon: message.location.longitude } : undefined,
  };
  return handleOnboardingMessage(io, session.id, incoming);
}

// ─── Entry point ───────────────────────────────────────────────────────────────

/** Telegram retries slow webhooks: drop an update id we have already handled. */
async function firstDelivery(updateId: number): Promise<boolean> {
  try {
    const result = await getRedisConnection().set(`tg:update:${updateId}`, "1", "EX", 3600, "NX");
    return result === "OK";
  } catch {
    return true;
  }
}

export async function handleTelegramUpdate(update: TgUpdate, io: BotIO = defaultIo): Promise<void> {
  if (!(await firstDelivery(update.update_id))) return;

  try {
    if (update.my_chat_member) {
      const status = update.my_chat_member.new_chat_member.status;
      if (status === "kicked" || status === "left") {
        await prisma.telegramChat.updateMany({
          where: { chatId: String(update.my_chat_member.chat.id) },
          data: { active: false },
        });
      }
      return;
    }
    if (update.callback_query) return await handleCallback(io, update);
    if (update.message) return await handleMessage(io, update.message);
  } catch (error) {
    if (error instanceof TelegramApiError && error.isForbidden) return;
    console.error("[Telegram bot] update failed:", error instanceof Error ? error.message : error);
  }
}
