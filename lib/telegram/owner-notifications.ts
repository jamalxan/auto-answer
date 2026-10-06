/**
 * Proactive messages to the business owner in Telegram (TZ 3A):
 *  - daily digest of questions the assistant could not answer (3A.7)
 *  - monthly "are your prices still current?" nudge (3A.6)
 *  - one reminder when onboarding stalls (3A.5)
 * Each one limits itself, so calling them hourly from cron is safe.
 */

import { prisma } from "@/lib/db/client";
import { runTokenExpiryWarnings } from "@/lib/integrations/expiry";
import { esc, isTelegramConfigured, sendMessage, TelegramApiError } from "./api";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const TASHKENT_OFFSET_MIN = 300;

type BotLang = "uz" | "ru";

function localHour(now = new Date()): number {
  return new Date(now.getTime() + TASHKENT_OFFSET_MIN * 60_000).getUTCHours();
}

async function ownerChats(workspaceId: string) {
  return prisma.telegramUser.findMany({
    where: { workspaceId },
    select: { tgUserId: true, language: true },
  });
}

async function safeSend(
  chatId: string,
  text: string,
  keyboard?: Array<Array<{ text: string; callback_data: string }>>
) {
  try {
    await sendMessage(chatId, text, { keyboard });
    return true;
  } catch (error) {
    if (error instanceof TelegramApiError && error.isForbidden) return false;
    console.error("[Owner notify] send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

// ─── Knowledge-gap digest ──────────────────────────────────────────────────────

const DIGEST = {
  uz: {
    title: (n: number) => `Bugun mijozlar ${n} ta savolga javob ololmadi:`,
    times: (n: number) => `${n} marta`,
    answer: "✍️ Javob berish",
    ignore: "🙈 E'tiborsiz qoldirish",
  },
  ru: {
    title: (n: number) => `Сегодня клиенты не получили ответ на ${n} вопрос(ов):`,
    times: (n: number) => `${n} раз`,
    answer: "✍️ Ответить",
    ignore: "🙈 Игнорировать",
  },
} as const;

export function buildGapDigest(
  gaps: Array<{ id: string; question: string; hits: number }>,
  lang: BotLang
) {
  const t = DIGEST[lang];
  const lines = gaps.map((g, i) => `${i + 1}) ${esc(g.question)} (${t.times(g.hits)})`);
  const text = `${t.title(gaps.length)}\n\n${lines.join("\n")}`;
  const keyboard = gaps.map((g, i) => [
    { text: `${i + 1}. ${t.answer}`, callback_data: `gap_answer:${g.id}` },
    { text: t.ignore, callback_data: `gap_ignore:${g.id}` },
  ]);
  return { text, keyboard };
}

/** At most one digest per workspace per day, sent around 10:00 Tashkent time. */
export async function runGapDigest(now = new Date()): Promise<number> {
  if (!isTelegramConfigured() || localHour(now) !== 10) return 0;
  const workspaces = await prisma.knowledgeGap.groupBy({
    by: ["workspaceId"],
    where: { status: "OPEN" },
  });

  let sent = 0;
  for (const { workspaceId } of workspaces) {
    const gaps = await prisma.knowledgeGap.findMany({
      where: { workspaceId, status: "OPEN" },
      orderBy: [{ hits: "desc" }, { createdAt: "asc" }],
      take: 5,
    });
    if (gaps.length === 0) continue;
    const recentlyNotified = gaps.some(
      (g) => g.lastNotifiedAt && now.getTime() - g.lastNotifiedAt.getTime() < 20 * HOUR_MS
    );
    if (recentlyNotified) continue;

    for (const user of await ownerChats(workspaceId)) {
      const lang: BotLang = user.language === "ru" ? "ru" : "uz";
      const digest = buildGapDigest(
        gaps.map((g) => ({
          id: g.id,
          question: (Array.isArray(g.examples) && (g.examples as string[])[0]) || g.questionNormalized,
          hits: g.hits,
        })),
        lang
      );
      if (await safeSend(user.tgUserId, digest.text, digest.keyboard)) sent++;
    }
    await prisma.knowledgeGap.updateMany({
      where: { id: { in: gaps.map((g) => g.id) } },
      data: { lastNotifiedAt: now },
    });
  }
  return sent;
}

// ─── Price reminder ────────────────────────────────────────────────────────────

const PRICE = {
  uz: {
    text: "Narxlaringiz hali ham shu holatdami?",
    yes: "✅ Ha",
    update: "✏️ Yangilayman",
  },
  ru: {
    text: "Ваши цены всё ещё актуальны?",
    yes: "✅ Да",
    update: "✏️ Обновлю",
  },
} as const;

/** Monthly, for profiles whose prices have not changed for 30 days. */
export async function runPriceReminders(now = new Date()): Promise<number> {
  if (!isTelegramConfigured() || localHour(now) !== 11) return 0;
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);

  const profiles = await prisma.assistantProfile.findMany({
    where: {
      enabled: true,
      approvedAt: { not: null },
      priceReminderEnabled: true,
      pricePolicy: { not: "NEVER" },
      OR: [{ priceReminderSentAt: null }, { priceReminderSentAt: { lt: cutoff } }],
      products: { some: { price: { not: null }, priceUpdatedAt: { lt: cutoff } } },
    },
    select: { id: true, workspaceId: true },
  });

  let sent = 0;
  for (const profile of profiles) {
    for (const user of await ownerChats(profile.workspaceId)) {
      const lang: BotLang = user.language === "ru" ? "ru" : "uz";
      const t = PRICE[lang];
      const ok = await safeSend(user.tgUserId, t.text, [
        [
          { text: t.yes, callback_data: `price_ok:${profile.id}` },
          { text: t.update, callback_data: `price_update:${profile.id}` },
        ],
      ]);
      if (ok) sent++;
    }
    await prisma.assistantProfile.update({
      where: { id: profile.id },
      data: { priceReminderSentAt: now },
    });
  }
  return sent;
}

// ─── Stalled onboarding ────────────────────────────────────────────────────────

const STALL = {
  uz: (step: number, total: number) =>
    `Sozlash ${step}/${total} da to'xtagan. Davom ettiramizmi? /profil`,
  ru: (step: number, total: number) =>
    `Настройка остановилась на ${step}/${total}. Продолжим? /profil`,
} as const;

/** One single reminder, 24 hours after the owner stopped answering. */
export async function runOnboardingReminders(now = new Date(), totalSteps = 11): Promise<number> {
  if (!isTelegramConfigured()) return 0;
  const cutoff = new Date(now.getTime() - DAY_MS);
  const sessions = await prisma.onboardingSession.findMany({
    where: {
      status: { in: ["ACTIVE", "PAUSED"] },
      reminderSentAt: null,
      updatedAt: { lt: cutoff },
    },
    take: 50,
  });

  let sent = 0;
  for (const session of sessions) {
    const lang: BotLang = session.language === "ru" ? "ru" : "uz";
    const ok = await safeSend(session.tgUserId, STALL[lang](session.step + 1, totalSteps));
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { reminderSentAt: now },
    });
    if (ok) sent++;
  }
  return sent;
}

export async function runAllOwnerNotifications(now = new Date()) {
  return {
    gaps: await runGapDigest(now),
    prices: await runPriceReminders(now),
    onboarding: await runOnboardingReminders(now),
    tokenExpiry: await runTokenExpiryWarnings(now),
  };
}
