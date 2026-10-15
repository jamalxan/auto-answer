/**
 * Diagnostics checklist (TZ §51, §60): one row per subsystem, each with
 * Status / Nima degani / Oxirgi tekshiruv / Mumkin muammo / Tavsiya.
 *
 * Every check is a pure `build…Check(input, now)` so the rules are tested
 * without a database; `runDiagnostics` only loads the inputs. A failing
 * loader turns its row into "unknown" instead of failing the page.
 */

import { prisma } from "@/lib/db/client";
import { getLlmProvider } from "@/lib/assistant/llm/provider";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { isTelegramConfigured } from "@/lib/telegram/api";
import type { ConnectionStatus } from "./connection-status";
import { loadConnections, type ConnectionView } from "./connections";
import { explainError, RECONNECT_HREF } from "./error-catalog";
import { loadQueueStats, type QueueStats } from "./queue-stats";
import { formatAgo, formatMinutes, toDate, withTimeout } from "./time";

export type DiagnosticStatus = "ok" | "warning" | "error" | "unknown";

export interface DiagnosticItem {
  key: string;
  label: string;
  status: DiagnosticStatus;
  /** Short value shown in the list ("2 daqiqa oldin", "Normal"). */
  value: string;
  /** "What it means" */
  meaning: string;
  /** ISO time of the data the row is based on; null when unknown. */
  lastCheck: string | null;
  /** "Possible issue"; null when everything is fine. */
  issue: string | null;
  /** "Recommended action" */
  action: { label: string; href?: string } | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** No Instagram event for this long on a connected account is suspicious. */
export const QUIET_EVENT_MS = 3 * DAY_MS;

const RECONNECT_ACTION = { label: "Instagram'ni qayta ulash", href: RECONNECT_HREF };

function iso(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function unknownItem(key: string, label: string, meaning: string, now: Date): DiagnosticItem {
  return {
    key,
    label,
    status: "unknown",
    value: "Noma'lum",
    meaning,
    lastCheck: now.toISOString(),
    issue: "Ma'lumotni o'qib bo'lmadi (baza yoki Redis javob bermadi).",
    action: { label: "Sahifani yangilang. Takrorlansa — server holatini tekshiring." },
  };
}

// ── Instagram connection / Token ─────────────────────────────────────────────

export interface AccountInput {
  username: string;
  status: ConnectionStatus;
  webhookSubscribed: boolean;
  tokenCheckedAt: string | Date | null;
  expiresInDays: number | null;
}

const BROKEN: ConnectionStatus[] = ["EXPIRED", "INVALID", "RECONNECT_REQUIRED"];

function names(accounts: AccountInput[]): string {
  return accounts.map((a) => `@${a.username}`).join(", ");
}

function latestCheck(accounts: AccountInput[]): string | null {
  const times = accounts.map((a) => toDate(a.tokenCheckedAt)?.getTime() ?? 0).filter(Boolean);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function buildConnectionCheck(accounts: AccountInput[], now: Date): DiagnosticItem {
  const base = {
    key: "instagram",
    label: "Instagram ulanishi",
    meaning: "SocialAuto Instagram akkauntingizga ulanganmi va undan foydalana oladimi.",
    lastCheck: latestCheck(accounts) ?? now.toISOString(),
  };
  if (accounts.length === 0) {
    return {
      ...base,
      status: "error",
      value: "Akkaunt yo'q",
      issue: "Hech qanday Instagram akkaunt ulanmagan — avtomatlashtirish ishlamaydi.",
      action: { label: "Instagram akkaunt ulash", href: RECONNECT_HREF },
    };
  }
  const off = accounts.filter((a) => a.status === "DISCONNECTED" || a.status === "RECONNECT_REQUIRED");
  const live = accounts.length - off.length;
  if (live === 0) {
    return {
      ...base,
      status: "error",
      value: "Uzilgan",
      issue: `Barcha akkauntlar uzilgan: ${names(off)}.`,
      action: RECONNECT_ACTION,
    };
  }
  if (off.length > 0) {
    return {
      ...base,
      status: "warning",
      value: `${live}/${accounts.length} ulangan`,
      issue: `Uzilgan akkauntlar: ${names(off)}.`,
      action: RECONNECT_ACTION,
    };
  }
  return { ...base, status: "ok", value: `${live} ta ulangan`, issue: null, action: null };
}

export function buildTokenCheck(accounts: AccountInput[], now: Date): DiagnosticItem {
  const base = {
    key: "token",
    label: "Token",
    meaning: "Instagram bergan ruxsat kaliti (access token) amal qilyaptimi va qachon tugaydi.",
    lastCheck: latestCheck(accounts) ?? now.toISOString(),
  };
  // Disconnected accounts are the connection row's problem, not the token's.
  const relevant = accounts.filter((a) => a.status !== "DISCONNECTED");
  if (relevant.length === 0) {
    return {
      ...base,
      status: "unknown",
      value: "Tekshirilmadi",
      issue: "Tekshiradigan ulangan akkaunt yo'q.",
      action: null,
    };
  }
  const broken = relevant.filter((a) => BROKEN.includes(a.status));
  if (broken.length > 0) {
    return {
      ...base,
      status: "error",
      value: broken.some((a) => a.status === "EXPIRED") ? "Muddati tugagan" : "Yaroqsiz",
      issue: `Token ishlamayapti: ${names(broken)}. Xabarlar yuborilmayapti.`,
      action: RECONNECT_ACTION,
    };
  }
  const stale = relevant.filter((a) => a.status === "ERROR");
  if (stale.length > 0) {
    return {
      ...base,
      status: "warning",
      value: "Holati noma'lum",
      issue: `Token tekshiruvi ishlamagan yoki xato bergan: ${names(stale)}.`,
      action: { label: "Ulanishlar bo'limida «Qayta tekshirish»ni bosing." },
    };
  }
  const expiring = relevant.filter((a) => a.status === "EXPIRING");
  if (expiring.length > 0) {
    const days = Math.min(...expiring.map((a) => a.expiresInDays ?? 0));
    return {
      ...base,
      status: "warning",
      value: `${Math.max(days, 0)} kunda tugaydi`,
      issue: `Token tez orada tugaydi va avtomatik yangilanmadi: ${names(expiring)}.`,
      action: RECONNECT_ACTION,
    };
  }
  return { ...base, status: "ok", value: "Amal qilyapti", issue: null, action: null };
}

// ── Messaging API ────────────────────────────────────────────────────────────

export interface MessagingInput {
  lastSentAt: Date | string | null;
  /** FAILED DmLog in the last 24h, newest first. */
  recentFailures: Array<{ errorMessage: string | null; at: Date | string }>;
}

const BLOCKING_CODES = new Set([
  "IG_PERMISSION",
  "IG_TOKEN_EXPIRED",
  "IG_TOKEN_INVALID",
  "IG_TOKEN_UNREADABLE",
  "IG_APP_REMOVED",
  "IG_PASSWORD_CHANGED",
  "IG_ACCOUNT_CHECKPOINT",
  "IG_ACCOUNT_UNCONFIRMED",
  "IG_DISCONNECTED",
]);

export function buildMessagingCheck(input: MessagingInput, now: Date): DiagnosticItem {
  const lastSent = toDate(input.lastSentAt);
  const base = {
    key: "messaging",
    label: "Messaging API",
    meaning: "Instagram orqali DM yuborish ishlayaptimi (oxirgi yuborilgan xabar va so'nggi xatolar bo'yicha).",
    lastCheck: now.toISOString(),
  };
  // Only failures newer than the last successful send describe the present.
  const current = input.recentFailures.filter((f) => !lastSent || (toDate(f.at)?.getTime() ?? 0) > lastSent.getTime());
  const blocking = current.map((f) => explainError(f.errorMessage ?? "")).filter((e) => BLOCKING_CODES.has(e.code));

  if (blocking.length > 0) {
    return {
      ...base,
      status: "error",
      value: "Yuborilmayapti",
      issue: `${blocking[0].problem} ${blocking[0].cause}`,
      action: { label: blocking[0].solution, href: blocking[0].action.href },
    };
  }
  if (current.length > 0) {
    return {
      ...base,
      status: "warning",
      value: `${current.length} ta xato`,
      issue: `Oxirgi muvaffaqiyatli yuborishdan keyin ${current.length} ta xabar yuborilmadi.`,
      action: { label: "«Xatolar» bo'limida sabablarini ko'ring." },
    };
  }
  if (!lastSent) {
    return {
      ...base,
      status: "unknown",
      value: "Hali yuborilmagan",
      issue: "Hali birorta DM yuborilmagan — API ishlashini tasdiqlab bo'lmaydi.",
      action: { label: "Test kommenti yozib, kampaniya ishlashini tekshiring." },
    };
  }
  return {
    ...base,
    status: "ok",
    value: `Oxirgi DM: ${formatAgo(lastSent, now)}`,
    lastCheck: lastSent.toISOString(),
    issue: null,
    action: null,
  };
}

// ── Webhook / Last event ─────────────────────────────────────────────────────

export interface WebhookInput {
  accounts: AccountInput[];
  lastWebhookAt: Date | string | null;
  failed24h: number;
}

export function buildWebhookCheck(input: WebhookInput, now: Date): DiagnosticItem {
  const base = {
    key: "webhook",
    label: "Webhook",
    meaning: "Instagram yangi komment va xabarlarni SocialAuto'ga real vaqtda yuboryaptimi.",
    lastCheck: iso(input.lastWebhookAt) ?? now.toISOString(),
  };
  const live = input.accounts.filter((a) => a.status !== "DISCONNECTED" && a.status !== "RECONNECT_REQUIRED");
  if (live.length === 0) {
    return { ...base, status: "unknown", value: "Akkaunt yo'q", issue: "Ulangan akkaunt yo'q.", action: null };
  }
  const unsubscribed = live.filter((a) => !a.webhookSubscribed);
  if (unsubscribed.length > 0) {
    return {
      ...base,
      status: "error",
      value: "Obuna yo'q",
      issue: `Webhook obunasi yo'q: ${names(unsubscribed)}. Yangi kommentlar faqat sekin polling orqali keladi.`,
      action: RECONNECT_ACTION,
    };
  }
  if (input.failed24h > 0) {
    return {
      ...base,
      status: "warning",
      value: `${input.failed24h} ta xato (24 soat)`,
      issue: "Ba'zi webhook eventlarini qayta ishlab bo'lmadi.",
      action: { label: "«Xatolar» bo'limida sabablarini ko'ring." },
    };
  }
  return { ...base, status: "ok", value: "Obuna faol", issue: null, action: null };
}

export function buildLastEventCheck(lastEventAt: Date | string | null, hasLiveAccount: boolean, now: Date): DiagnosticItem {
  const last = toDate(lastEventAt);
  const base = {
    key: "last_event",
    label: "Oxirgi event",
    meaning: "Instagram'dan oxirgi marta qachon event (komment, DM, story reply) kelgan.",
    lastCheck: last?.toISOString() ?? now.toISOString(),
  };
  if (!last) {
    return {
      ...base,
      status: hasLiveAccount ? "warning" : "unknown",
      value: "Hali kelmagan",
      issue: hasLiveAccount ? "Ulangan akkauntga hali birorta event kelmagan — webhook ishlamayotgan bo'lishi mumkin." : null,
      action: hasLiveAccount ? { label: "Postga test komment yozing va bu yerda paydo bo'lishini kuting." } : null,
    };
  }
  if (hasLiveAccount && now.getTime() - last.getTime() > QUIET_EVENT_MS) {
    return {
      ...base,
      status: "warning",
      value: formatAgo(last, now),
      issue: "3 kundan beri birorta event kelmagan. Akkaunt jim bo'lishi yoki webhook uzilgan bo'lishi mumkin.",
      action: { label: "Postga test komment yozing; kelmasa — akkauntni qayta ulang.", href: RECONNECT_HREF },
    };
  }
  return { ...base, status: "ok", value: formatAgo(last, now), issue: null, action: null };
}

// ── Rate limit / Queue / Worker ──────────────────────────────────────────────

export function buildRateLimitCheck(rate: QueueStats["rate"], now: Date): DiagnosticItem {
  const base = {
    key: "rate_limit",
    label: "Rate limit",
    meaning: "Bitta akkauntdan soatiga 750 tagacha private reply yuborish mumkin (Meta limiti).",
    lastCheck: now.toISOString(),
  };
  if (rate.length === 0) return { ...base, status: "unknown", value: "Akkaunt yo'q", issue: null, action: null };
  const known = rate.filter((r) => r.usage);
  if (known.length === 0) {
    return {
      ...base,
      status: "unknown",
      value: "Noma'lum",
      issue: "Limit hisoblagichini o'qib bo'lmadi (Redis javob bermadi).",
      action: { label: "Server holatini tekshiring." },
    };
  }
  const worst = known.reduce((a, b) => (b.usage!.percent > a.usage!.percent ? b : a));
  const usage = worst.usage!;
  const value = `${usage.used}/${usage.limit} (@${worst.username})`;
  if (usage.percent >= 100) {
    const minutes = usage.resetInSeconds !== null ? Math.ceil(usage.resetInSeconds / 60) : null;
    return {
      ...base,
      status: "error",
      value,
      issue: `@${worst.username} soatlik limitga yetdi — yangi xabarlar navbatda kutyapti.`,
      action: { label: minutes !== null ? `${minutes} daqiqada limit yangilanadi; kutish kifoya.` : "Limit yangilanishini kuting." },
    };
  }
  if (usage.percent >= 80) {
    return {
      ...base,
      status: "warning",
      value,
      issue: `@${worst.username} soatlik limitning ${usage.percent}% ini ishlatdi.`,
      action: { label: "Hozircha harakat shart emas; limitga yetsa xabarlar navbatda kutadi." },
    };
  }
  return { ...base, status: "ok", value: "Normal", issue: null, action: null };
}

export function buildQueueCheck(queue: QueueStats["dm"], workerHealthy: boolean | null, now: Date): DiagnosticItem {
  const base = {
    key: "queue",
    label: "Navbat",
    meaning: "Yuborilishini kutayotgan xabarlar soni va taxminiy tugash vaqti.",
    lastCheck: now.toISOString(),
  };
  if (queue.queued === null) {
    return {
      ...base,
      status: "unknown",
      value: "Noma'lum",
      issue: "Navbatni o'qib bo'lmadi (Redis javob bermadi).",
      action: { label: "Server holatini tekshiring." },
    };
  }
  const value = queue.queued > 0 ? `${queue.queued} · ${queue.etaLabel}` : "0";
  if (queue.queued > 0 && workerHealthy === false) {
    return {
      ...base,
      status: "error",
      value,
      issue: "Navbatda xabarlar bor, lekin worker ishlamayapti — ular yuborilmaydi.",
      action: { label: "Worker jarayonini qayta ishga tushiring." },
    };
  }
  if (queue.queued > 0 && queue.etaMinutes === null) {
    return {
      ...base,
      status: "warning",
      value,
      issue: "Oxirgi soatda birorta xabar yuborilmagan — navbat harakatlanmayapti bo'lishi mumkin.",
      action: { label: "Rate limit va Messaging API qatorlarini tekshiring." },
    };
  }
  if (queue.etaMinutes !== null && queue.etaMinutes > 60) {
    return {
      ...base,
      status: "warning",
      value,
      issue: "Navbat katta — xabarlar kechikib yetadi.",
      action: { label: "Kutish kifoya; limitlar tufayli tezlashtirib bo'lmaydi." },
    };
  }
  return { ...base, status: "ok", value, issue: null, action: null };
}

export interface WorkerInput {
  healthy: boolean;
  ageMs: number | null;
}

export function buildWorkerCheck(worker: WorkerInput | null, now: Date): DiagnosticItem {
  const base = {
    key: "worker",
    label: "Worker",
    meaning: "Xabarlarni navbatdan olib yuboradigan fon jarayoni ishlayaptimi.",
    lastCheck:
      worker?.ageMs != null ? new Date(now.getTime() - worker.ageMs).toISOString() : now.toISOString(),
  };
  if (!worker) {
    return {
      ...base,
      status: "unknown",
      value: "Noma'lum",
      issue: "Worker holatini o'qib bo'lmadi (Redis javob bermadi).",
      action: { label: "Server holatini tekshiring." },
    };
  }
  if (!worker.healthy) {
    return {
      ...base,
      status: "error",
      value: worker.ageMs === null ? "Signal yo'q" : `Oxirgi signal: ${formatAgo(new Date(now.getTime() - worker.ageMs), now)}`,
      issue: "Worker ishlamayapti — yangi xabarlar navbatda qolib ketadi.",
      action: { label: "Worker jarayonini qayta ishga tushiring." },
    };
  }
  return { ...base, status: "ok", value: "Ishlayapti", issue: null, action: null };
}

// ── AI / CRM / Telegram ──────────────────────────────────────────────────────

export interface AiInput {
  configured: boolean;
  model: string | null;
  templateOnlyUntil: Date | string | null;
}

export function buildAiCheck(input: AiInput, now: Date): DiagnosticItem {
  const base = {
    key: "ai",
    label: "AI",
    meaning: "AI assistent (JavobAI) uchun til modeli sozlanganmi va hozir ishlayaptimi.",
    lastCheck: now.toISOString(),
  };
  if (!input.configured) {
    return {
      ...base,
      status: "warning",
      value: "Sozlanmagan",
      issue: "LLM provider sozlanmagan — assistent AI javob bera olmaydi.",
      action: { label: "Serverda LLM_PROVIDER, LLM_MODEL va API kalitini sozlang." },
    };
  }
  const until = toDate(input.templateOnlyUntil);
  if (until && until.getTime() > now.getTime()) {
    return {
      ...base,
      status: "warning",
      value: "Faqat shablonlar",
      issue: `AI provider ketma-ket xato bergani uchun assistent yana ${formatMinutes((until.getTime() - now.getTime()) / 60_000)} faqat shablon javoblar beradi.`,
      action: { label: "O'zi tiklanadi. Tez-tez takrorlansa — provider kalit va limitlarini tekshiring." },
    };
  }
  return { ...base, status: "ok", value: input.model ? `Ishlayapti · ${input.model}` : "Ishlayapti", issue: null, action: null };
}

export interface CrmInput {
  integrations: Array<{ name: string; type: string; status: string; lastError: string | null; lastCheckedAt: Date | string | null }>;
  failed24h: number;
  dead24h: number;
}

export function buildCrmCheck(input: CrmInput, now: Date): DiagnosticItem {
  const checks = input.integrations.map((i) => toDate(i.lastCheckedAt)?.getTime() ?? 0).filter(Boolean);
  const base = {
    key: "crm",
    label: "CRM",
    meaning: "amoCRM / Bitrix24 integratsiyasi lidlarni qabul qilyaptimi.",
    lastCheck: checks.length ? new Date(Math.max(...checks)).toISOString() : now.toISOString(),
  };
  const enabled = input.integrations.filter((i) => i.status !== "DISABLED");
  if (enabled.length === 0) {
    return { ...base, status: "unknown", value: "Ulanmagan", issue: null, action: null };
  }
  const broken = enabled.filter((i) => i.status === "BROKEN");
  if (broken.length > 0) {
    return {
      ...base,
      status: "error",
      value: "Uzilgan",
      issue: `${broken.map((i) => i.name).join(", ")} ulanishi uzilgan — lidlar CRM'ga tushmayapti.`,
      action: { label: "Integratsiyalar sahifasida CRM'ni qayta ulang.", href: "/integrations" },
    };
  }
  if (input.dead24h > 0) {
    return {
      ...base,
      status: "error",
      value: `${input.dead24h} ta lid yetkazilmadi`,
      issue: "Ba'zi lidlar bir necha urinishdan keyin ham CRM'ga yuborilmadi.",
      action: { label: "CRM sozlamalari va huquqlarini tekshiring.", href: "/integrations" },
    };
  }
  if (input.failed24h > 0) {
    return {
      ...base,
      status: "warning",
      value: `${input.failed24h} ta qayta urinish`,
      issue: "Ba'zi lidlarni yuborish xato berdi; tizim qayta urinyapti.",
      action: { label: "Kutish kifoya; takrorlansa — CRM ulanishini tekshiring." },
    };
  }
  return { ...base, status: "ok", value: "Ishlayapti", issue: null, action: null };
}

export interface TelegramInput {
  botConfigured: boolean;
  linkedUsers: number;
  activeChats: number;
}

export function buildTelegramCheck(input: TelegramInput, now: Date): DiagnosticItem {
  const base = {
    key: "telegram",
    label: "Telegram",
    meaning: "Ulanish uzilsa yoki lid kelsa Telegram orqali xabar olasizmi.",
    lastCheck: now.toISOString(),
  };
  if (!input.botConfigured) {
    return {
      ...base,
      status: "unknown",
      value: "Bot sozlanmagan",
      issue: "Serverda Telegram bot sozlanmagan — ogohlantirishlar yuborilmaydi.",
      action: { label: "Serverda TELEGRAM_BOT_TOKEN ni sozlang." },
    };
  }
  if (input.activeChats === 0 && input.linkedUsers === 0) {
    return {
      ...base,
      status: "warning",
      value: "Ulanmagan",
      issue: "Telegram ulanmagan — Instagram uzilsa bu haqda xabar olmaysiz.",
      action: { label: "Integratsiyalar sahifasida Telegram'ni ulang.", href: "/integrations" },
    };
  }
  return {
    ...base,
    status: "ok",
    value: `Ulangan · ${input.activeChats} chat`,
    issue: null,
    action: null,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Settles a loader: `{ value }` on success, null on failure — so "no row"
 * (value null) and "could not read" stay distinguishable, and one broken
 * source never fails the page.
 */
async function settle<T>(promise: Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await promise };
  } catch (error) {
    console.error("[Foundation] diagnostics loader failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function loadAi(workspaceId: string) {
  return prisma.workspace
    .findUnique({ where: { id: workspaceId }, select: { assistantTemplateOnlyUntil: true } })
    .then((workspace) => {
      let provider: ReturnType<typeof getLlmProvider> = null;
      try {
        provider = getLlmProvider();
      } catch {
        provider = null;
      }
      return {
        configured: Boolean(provider),
        model: provider?.model ?? null,
        templateOnlyUntil: workspace?.assistantTemplateOnlyUntil ?? null,
      };
    });
}

async function loadCrm(workspaceId: string, since: Date): Promise<CrmInput> {
  const crmTypes = ["AMOCRM", "BITRIX24"] as const;
  const [integrations, failures] = await Promise.all([
    prisma.integration.findMany({
      where: { workspaceId, type: { in: [...crmTypes] } },
      select: { name: true, type: true, status: true, lastError: true, lastCheckedAt: true },
    }),
    prisma.leadDelivery.groupBy({
      by: ["status"],
      where: {
        status: { in: ["FAILED", "DEAD"] },
        updatedAt: { gte: since },
        integration: { workspaceId, type: { in: [...crmTypes] } },
      },
      _count: { _all: true },
    }),
  ]);
  const count = (status: string) => failures.find((row) => row.status === status)?._count._all ?? 0;
  return { integrations, failed24h: count("FAILED"), dead24h: count("DEAD") };
}

async function loadTelegram(workspaceId: string): Promise<TelegramInput> {
  const [linkedUsers, activeChats] = await Promise.all([
    prisma.telegramUser.count({ where: { workspaceId } }),
    // Same filter alertWorkspace uses to pick its recipients.
    prisma.telegramChat.count({
      where: { active: true, integration: { workspaceId, type: "TELEGRAM", status: "ACTIVE" } },
    }),
  ]);
  return { botConfigured: isTelegramConfigured(), linkedUsers, activeChats };
}

export interface DiagnosticsPreloaded {
  connections?: ConnectionView[];
  queue?: QueueStats;
  worker?: WorkerInput | null;
}

export async function runDiagnostics(
  workspaceId: string,
  preloaded: DiagnosticsPreloaded = {},
  now: Date = new Date()
): Promise<DiagnosticItem[]> {
  const since24h = new Date(now.getTime() - DAY_MS);
  const given = <T>(value: T) => Promise.resolve({ value });

  const [connections, queue, worker, lastSent, failures, lastWebhook, webhookFailed, lastTriggerEvent, ai, crm, telegram] =
    await Promise.all([
      preloaded.connections ? given(preloaded.connections) : settle(loadConnections(workspaceId, now)),
      preloaded.queue ? given(preloaded.queue) : settle(loadQueueStats(workspaceId, { now })),
      "worker" in preloaded ? Promise.resolve(preloaded.worker ?? null) : withTimeout(getWorkerHealth()),
      settle(
        prisma.dmLog.findFirst({
          where: { workspaceId, status: "SENT", dmSentAt: { not: null } },
          orderBy: { dmSentAt: "desc" },
          select: { dmSentAt: true },
        })
      ),
      settle(
        prisma.dmLog.findMany({
          where: { workspaceId, status: "FAILED", updatedAt: { gte: since24h } },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { errorMessage: true, updatedAt: true },
        })
      ),
      settle(
        prisma.webhookEvent.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        })
      ),
      settle(prisma.webhookEvent.count({ where: { workspaceId, status: "FAILED", createdAt: { gte: since24h } } })),
      settle(
        prisma.instagramEvent.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        })
      ),
      settle(loadAi(workspaceId)),
      settle(loadCrm(workspaceId, since24h)),
      settle(loadTelegram(workspaceId)),
    ]);

  const accounts: AccountInput[] | null = connections
    ? connections.value.map((c) => ({
        username: c.username,
        status: c.status,
        webhookSubscribed: c.webhookSubscribed,
        tokenCheckedAt: c.tokenCheckedAt,
        expiresInDays: c.expiresInDays,
      }))
    : null;
  const hasLiveAccount = (accounts ?? []).some((a) => a.status !== "DISCONNECTED" && a.status !== "RECONNECT_REQUIRED");

  const eventTimes = [lastWebhook?.value?.createdAt, lastTriggerEvent?.value?.createdAt]
    .map((d) => d?.getTime() ?? 0)
    .filter(Boolean);
  const lastEventAt = eventTimes.length ? new Date(Math.max(...eventTimes)) : null;

  return [
    accounts
      ? buildConnectionCheck(accounts, now)
      : unknownItem("instagram", "Instagram ulanishi", "SocialAuto Instagram akkauntingizga ulanganmi.", now),
    accounts ? buildTokenCheck(accounts, now) : unknownItem("token", "Token", "Instagram access token holati.", now),
    lastSent && failures
      ? buildMessagingCheck(
          {
            lastSentAt: lastSent.value?.dmSentAt ?? null,
            recentFailures: failures.value.map((f) => ({ errorMessage: f.errorMessage, at: f.updatedAt })),
          },
          now
        )
      : unknownItem("messaging", "Messaging API", "Instagram orqali DM yuborish ishlayaptimi.", now),
    accounts && lastWebhook && webhookFailed
      ? buildWebhookCheck(
          { accounts, lastWebhookAt: lastWebhook.value?.createdAt ?? null, failed24h: webhookFailed.value },
          now
        )
      : unknownItem("webhook", "Webhook", "Instagram eventlarni real vaqtda yuboryaptimi.", now),
    lastWebhook && lastTriggerEvent
      ? buildLastEventCheck(lastEventAt, hasLiveAccount, now)
      : unknownItem("last_event", "Oxirgi event", "Instagram'dan oxirgi event qachon kelgan.", now),
    queue ? buildRateLimitCheck(queue.value.rate, now) : unknownItem("rate_limit", "Rate limit", "Soatlik yuborish limiti.", now),
    queue
      ? buildQueueCheck(queue.value.dm, worker ? worker.healthy : null, now)
      : unknownItem("queue", "Navbat", "Yuborilishini kutayotgan xabarlar.", now),
    buildWorkerCheck(worker ? { healthy: worker.healthy, ageMs: worker.ageMs } : null, now),
    ai ? buildAiCheck(ai.value, now) : unknownItem("ai", "AI", "AI assistent holati.", now),
    crm ? buildCrmCheck(crm.value, now) : unknownItem("crm", "CRM", "CRM integratsiyasi holati.", now),
    telegram ? buildTelegramCheck(telegram.value, now) : unknownItem("telegram", "Telegram", "Telegram ogohlantirishlari.", now),
  ];
}
