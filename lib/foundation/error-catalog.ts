/**
 * Error catalog (TZ §5, §5.1, §61.4): any failure → Muammo / Sabab / Yechim /
 * Action, never a bare "OAuthException #190".
 *
 * Accepts a live error (MetaApiError and its subclasses, fetch failures) or a
 * string that was stored earlier (DmLog.errorMessage, tokenLastError,
 * WebhookEvent.errorMessage, OperationalEvent.message). Stored strings keep
 * Meta's real code in a "[code=4 sub=- …]" tail (lib/meta/client
 * handleResponse), which matters: the client folds codes 4/17 into
 * RateLimitError(368) and 10/200 into PermissionError(100), so the class alone
 * loses the original code.
 *
 * Pure: no DB, no network. lib/triggers/errors.ts stays the worker's
 * retry/no-retry decision; this file is the human explanation.
 */

import { IntegrationAuthError } from "@/lib/integrations/errors";
import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export type ErrorActionKind = "reconnect" | "recheck" | "wait" | "retry" | "check_settings" | "none";

export interface ErrorAction {
  kind: ErrorActionKind;
  label: string;
  href?: string;
}

export interface RelatedObject {
  type: string;
  id: string;
  label?: string;
}

export interface ExplainedError {
  /** Internal, stable code, e.g. "IG_TOKEN_EXPIRED". */
  code: string;
  severity: ErrorSeverity;
  retryable: boolean;
  problem: string;
  cause: string;
  solution: string;
  action: ErrorAction;
  /** Raw detail for developers; never the headline. */
  technical: string;
  timestamp?: string;
  related?: RelatedObject;
}

/** Where "Qayta ulash" goes: the normal OAuth start, it redirects back itself. */
// Comes back to the Foundation screen once Instagram is reconnected.
export const RECONNECT_HREF = "/api/instagram/connect?return=/developer/foundation";

const RECONNECT: ErrorAction = { kind: "reconnect", label: "Qayta ulash", href: RECONNECT_HREF };
const WAIT: ErrorAction = { kind: "wait", label: "Kutish — avtomatik qayta yuboriladi" };
const NONE: ErrorAction = { kind: "none", label: "Harakat shart emas" };

// ── Meta code parsing ────────────────────────────────────────────────────────

export interface MetaCodes {
  code?: number;
  subcode?: number;
}

function firstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

/**
 * Meta's code / subcode out of any stored error text. The bracketed tail
 * written by lib/meta/client wins: it is the code Meta actually sent, while
 * "Meta API Error 368:" (dm-worker formatError) is the remapped class code.
 */
export function parseMetaCodes(text: string): MetaCodes {
  const code = firstNumber(text, [
    /\[code=(\d+)/,
    /"code"\s*:\s*(\d+)/,
    /\(#(\d+)\)/,
    /\bcode=(\d+)/,
    /Meta API Error (\d+)/,
  ]);
  const subcode = firstNumber(text, [/\bsub=(\d+)/, /error_subcode"?\s*[:=]\s*(\d+)/, /subcode[ =:]+(\d+)/i]);
  return { code, subcode };
}

function rawText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input == null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function technicalText(input: unknown): string {
  if (input instanceof MetaApiError) {
    return `${input.name} code=${input.code}${input.subcode ? ` sub=${input.subcode}` : ""}: ${input.message}`;
  }
  if (input instanceof Error) return `${input.name}: ${input.message}`;
  return rawText(input);
}

/** Codes from a live error first (subcode survives only there), then its text. */
function codesOf(input: unknown, text: string): MetaCodes {
  const parsed = parseMetaCodes(text);
  if (input instanceof MetaApiError) {
    return {
      // Subclasses carry a remapped code; the message tail has the real one.
      code: parsed.code ?? input.code,
      subcode: input.subcode ?? parsed.subcode,
    };
  }
  return parsed;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

type Entry = Omit<ExplainedError, "technical" | "timestamp" | "related">;

export const ERROR_CATALOG = {
  IG_DISCONNECTED: {
    code: "IG_DISCONNECTED",
    severity: "critical",
    retryable: false,
    problem: "Instagram akkaunt uzilgan.",
    cause: "Akkaunt SocialAuto'dan uzilgan — saqlangan ulanish (token) yo'q.",
    solution: "Instagram akkauntingizni qayta ulang.",
    action: RECONNECT,
  },
  IG_APP_REMOVED: {
    code: "IG_APP_REMOVED",
    severity: "critical",
    retryable: false,
    problem: "Instagram SocialAuto'ga ruxsatni bekor qilgan.",
    cause: "Instagram sozlamalarida SocialAuto ilovasi o'chirilgan yoki ruxsatlari olib tashlangan.",
    solution: "Instagram akkauntingizni qayta ulang va barcha ruxsatlarni bering.",
    action: RECONNECT,
  },
  IG_TOKEN_EXPIRED: {
    code: "IG_TOKEN_EXPIRED",
    severity: "critical",
    retryable: false,
    problem: "Instagram ulanishi tugagan.",
    cause: "Instagram access token amal qilish muddatini tugatgan.",
    solution: "Instagram akkauntingizni qayta ulang.",
    action: RECONNECT,
  },
  IG_PASSWORD_CHANGED: {
    code: "IG_PASSWORD_CHANGED",
    severity: "critical",
    retryable: false,
    problem: "Instagram ulanishi bekor qilingan.",
    cause: "Instagram paroli o'zgartirilgan yoki Meta xavfsizlik sababli sessiyani yopgan.",
    solution: "Instagram akkauntingizni qayta ulang.",
    action: RECONNECT,
  },
  IG_ACCOUNT_CHECKPOINT: {
    code: "IG_ACCOUNT_CHECKPOINT",
    severity: "critical",
    retryable: false,
    problem: "Instagram akkaunt tekshiruvda (checkpoint).",
    cause: "Meta akkauntni vaqtincha bloklagan — egasi Instagram'ga kirib tasdiqlashi kerak.",
    solution: "Instagram ilovasiga kiring, tekshiruvdan o'ting, keyin akkauntni qayta ulang.",
    action: RECONNECT,
  },
  IG_ACCOUNT_UNCONFIRMED: {
    code: "IG_ACCOUNT_UNCONFIRMED",
    severity: "critical",
    retryable: false,
    problem: "Instagram akkaunt tasdiqlanmagan.",
    cause: "Akkaunt egasi Meta talab qilgan tasdiqlashni (email/telefon) yakunlamagan.",
    solution: "Instagram'da akkauntni tasdiqlang, keyin qayta ulang.",
    action: RECONNECT,
  },
  IG_TOKEN_INVALID: {
    code: "IG_TOKEN_INVALID",
    severity: "critical",
    retryable: false,
    problem: "Instagram ulanishi yaroqsiz.",
    cause: "Instagram saqlangan tokenni qabul qilmadi (bekor qilingan yoki buzilgan).",
    solution: "Instagram akkauntingizni qayta ulang.",
    action: RECONNECT,
  },
  IG_TOKEN_UNREADABLE: {
    code: "IG_TOKEN_UNREADABLE",
    severity: "critical",
    retryable: false,
    problem: "Saqlangan Instagram ulanishini o'qib bo'lmadi.",
    cause: "Token shifrini ochib bo'lmadi — serverdagi shifrlash kaliti (ENCRYPTION_KEY) o'zgargan bo'lishi mumkin.",
    solution: "Akkauntni qayta ulang. Bir nechta akkauntda takrorlansa — server sozlamasini tekshiring.",
    action: RECONNECT,
  },
  IG_RATE_LIMIT: {
    code: "IG_RATE_LIMIT",
    severity: "warning",
    retryable: true,
    problem: "Instagram limitiga yetildi.",
    cause: "Qisqa vaqtda juda ko'p so'rov yuborildi — Instagram vaqtincha cheklov qo'ydi.",
    solution: "Hech narsa qilish shart emas: xabarlar kutib, keyin qayta yuboriladi.",
    action: WAIT,
  },
  APP_HOURLY_DM_LIMIT: {
    code: "APP_HOURLY_DM_LIMIT",
    severity: "warning",
    retryable: true,
    problem: "Soatlik xabar limiti to'ldi.",
    cause: "Bitta akkauntdan soatiga belgilangan limitdan (standart 200, sozlanadi) ko'p xabar yuborilmaydi — Meta cheklovlaridan himoya.",
    solution: "Xabarlar navbatda turadi va limit yangilangach yuboriladi.",
    action: WAIT,
  },
  IG_PERMISSION: {
    code: "IG_PERMISSION",
    severity: "error",
    retryable: false,
    problem: "Instagram bu amalga ruxsat bermadi.",
    cause: "Ulanishda kerakli ruxsat yo'q (masalan, xabar yuborish) yoki akkaunt Business/Creator emas.",
    solution: "Akkauntni qayta ulang va so'ralgan barcha ruxsatlarni bering. Akkaunt professional ekanini tekshiring.",
    action: RECONNECT,
  },
  IG_USER_UNAVAILABLE: {
    code: "IG_USER_UNAVAILABLE",
    severity: "info",
    retryable: false,
    problem: "Bu odamga hozir yozib bo'lmaydi.",
    cause: "Foydalanuvchi xabarlarni cheklagan, sizni bloklagan yoki akkaunti mavjud emas.",
    solution: "Bu odamga boshqa yozib bo'lmaydi — harakat shart emas.",
    action: NONE,
  },
  IG_WINDOW_CLOSED: {
    code: "IG_WINDOW_CLOSED",
    severity: "info",
    retryable: false,
    problem: "24 soatlik xabar oynasi yopilgan.",
    cause: "Instagram foydalanuvchining oxirgi xabaridan 24 soat o'tgach yozishga ruxsat bermaydi.",
    solution: "Foydalanuvchi qayta yozsa, javob avtomatik ketadi.",
    action: NONE,
  },
  IG_USER_NOT_FOUND: {
    code: "IG_USER_NOT_FOUND",
    severity: "info",
    retryable: false,
    problem: "Foydalanuvchi topilmadi.",
    cause: "Akkaunt o'chirilgan, yopilgan yoki Instagram uni topa olmadi.",
    solution: "Harakat shart emas.",
    action: NONE,
  },
  IG_PRIVATE_REPLY_USED: {
    code: "IG_PRIVATE_REPLY_USED",
    severity: "info",
    retryable: false,
    problem: "Bu kommentga javob allaqachon yuborilgan.",
    cause: "Instagram har bir kommentga faqat bitta private reply yuborishga ruxsat beradi.",
    solution: "Harakat shart emas.",
    action: NONE,
  },
  IG_INVALID_PARAMETER: {
    code: "IG_INVALID_PARAMETER",
    severity: "error",
    retryable: false,
    problem: "Instagram so'rovni qabul qilmadi.",
    cause: "So'rovdagi ma'lumot noto'g'ri: komment/post o'chirilgan yoki xabar formati mos emas.",
    solution: "Post yoki komment hali mavjudligini tekshiring. Takrorlansa — texnik ma'lumotni dasturchiga yuboring.",
    action: { kind: "check_settings", label: "Sozlamani tekshirish" },
  },
  IG_TEMPORARY: {
    code: "IG_TEMPORARY",
    severity: "warning",
    retryable: true,
    problem: "Instagram API vaqtincha javob bermadi.",
    cause: "Meta tomonida vaqtinchalik nosozlik.",
    solution: "Avtomatik qayta urinish bo'ladi. Uzoq davom etsa — Meta holat sahifasini tekshiring.",
    action: { kind: "retry", label: "Keyinroq qayta urinish" },
  },
  NETWORK_ERROR: {
    code: "NETWORK_ERROR",
    severity: "warning",
    retryable: true,
    problem: "Instagram bilan aloqa uzildi.",
    cause: "Tarmoq xatosi yoki javob kutish vaqti tugadi.",
    solution: "Avtomatik qayta urinish bo'ladi.",
    action: { kind: "retry", label: "Keyinroq qayta urinish" },
  },
  PLAN_LIMIT: {
    code: "PLAN_LIMIT",
    severity: "warning",
    retryable: false,
    problem: "Oylik xabar limiti tugadi.",
    cause: "Tarifingizdagi oylik DM soni to'ldi.",
    solution: "Keyingi davrni kuting yoki tarifni oshiring.",
    action: { kind: "check_settings", label: "Tarifni ko'rish", href: "/settings" },
  },
  WORKSPACE_SUSPENDED: {
    code: "WORKSPACE_SUSPENDED",
    severity: "critical",
    retryable: false,
    problem: "Workspace to'xtatilgan.",
    cause: "Platforma administratori workspace'ni vaqtincha to'xtatgan.",
    solution: "Qo'llab-quvvatlash xizmatiga murojaat qiling.",
    action: NONE,
  },
  WEBHOOK_SIGNATURE: {
    code: "WEBHOOK_SIGNATURE",
    severity: "critical",
    retryable: false,
    problem: "Instagram eventlarini tekshirib bo'lmayapti.",
    cause: "Webhook imzosini tekshirish uchun server sozlamasi (app secret) yo'q yoki noto'g'ri.",
    solution: "Server sozlamalarini tekshiring — bu hal bo'lmaguncha yangi eventlar qabul qilinmaydi.",
    action: { kind: "check_settings", label: "Server sozlamasi" },
  },
  INTEGRATION_AUTH_EXPIRED: {
    code: "INTEGRATION_AUTH_EXPIRED",
    severity: "critical",
    retryable: false,
    problem: "CRM ulanishi tugagan (amoCRM / Bitrix24 kirishni rad etdi).",
    cause: "CRM tokeni amal qilish muddatini tugatgan, bekor qilingan yoki ruxsati olib tashlangan (401/403).",
    solution: "Integratsiyalar bo'limida CRM'ni yangi token bilan qayta ulang. Kutayotgan lidlar ulanish tiklangach avtomatik yuboriladi.",
    action: { kind: "reconnect", label: "Qayta ulash", href: "/integrations" },
  },
  // ── Content Scheduler (ETAP 13, spec §11) ────────────────────────────────
  PUBLISH_TOKEN_EXPIRED: {
    code: "PUBLISH_TOKEN_EXPIRED",
    severity: "critical",
    retryable: true,
    problem: "Instagram ulanishi uzildi — post chiqmadi.",
    cause: "Akkauntning access tokeni endi ishlamaydi.",
    solution: "Akkauntni qayta ulang; rejalashtirilgan postlar 15 daqiqa ichida davom etadi.",
    action: RECONNECT,
  },
  PUBLISH_NO_PERMISSION: {
    code: "PUBLISH_NO_PERMISSION",
    severity: "critical",
    retryable: false,
    problem: "Post chiqarish ruxsati berilmagan.",
    cause: "Instagram ulanishida instagram_business_content_publish ruxsati yo'q.",
    solution: "Akkauntni qayta ulang va barcha ruxsatlarni bering.",
    action: RECONNECT,
  },
  PUBLISH_QUOTA: {
    code: "PUBLISH_QUOTA",
    severity: "warning",
    retryable: true,
    problem: "24 soatlik post limiti to'ldi.",
    cause: "Instagram API bir akkauntga 24 soatda cheklangan sonda post chiqarishga ruxsat beradi.",
    solution: "Post limit bo'shagan vaqtga ko'chirildi; kerak bo'lsa boshqa vaqt tanlang.",
    action: WAIT,
  },
  PUBLISH_RATE_LIMIT: {
    code: "PUBLISH_RATE_LIMIT",
    severity: "warning",
    retryable: true,
    problem: "Instagram vaqtincha so'rovlarni cheklamoqda.",
    cause: "Qisqa vaqtda juda ko'p API so'rovi yuborildi.",
    solution: "Avtomatik qayta uriniladi (1, 2, 4, 8 daqiqa).",
    action: WAIT,
  },
  PUBLISH_MEDIA_FETCH: {
    code: "PUBLISH_MEDIA_FETCH",
    severity: "error",
    retryable: true,
    problem: "Instagram faylni yuklab ololmadi.",
    cause: "Media havolasi ochilmadi yoki vaqtincha mavjud emas edi.",
    solution: "Yangi havola bilan 3 marta qayta uriniladi; takrorlansa faylni qayta yuklang.",
    action: { kind: "retry", label: "Qayta urinish" },
  },
  PUBLISH_MEDIA_INVALID: {
    code: "PUBLISH_MEDIA_INVALID",
    severity: "error",
    retryable: false,
    problem: "Instagram faylni qabul qilmadi.",
    cause: "Format, nisbat, davomiylik yoki hajm Instagram talabiga mos emas.",
    solution: "Faylni Instagram talabiga moslang (kesish, qisqartirish) yoki qo'lda chiqaring.",
    action: { kind: "check_settings", label: "Postni tahrirlash" },
  },
  PUBLISH_CONTAINER_TIMEOUT: {
    code: "PUBLISH_CONTAINER_TIMEOUT",
    severity: "error",
    retryable: true,
    problem: "Instagram videoni qayta ishlay olmadi.",
    cause: "Konteyner 20 daqiqada tayyor bo'lmadi.",
    solution: "Qayta urinib ko'ring; takrorlansa videoni qisqartiring yoki qo'lda chiqaring.",
    action: { kind: "retry", label: "Qayta urinish" },
  },
  PUBLISH_CONTAINER_EXPIRED: {
    code: "PUBLISH_CONTAINER_EXPIRED",
    severity: "warning",
    retryable: true,
    problem: "Instagram konteyneri eskirdi.",
    cause: "Konteyner 24 soatdan ko'p turib qoldi.",
    solution: "Yangi konteyner bilan avtomatik qayta uriniladi.",
    action: WAIT,
  },
  PUBLISH_INVALID_USER_TAG: {
    code: "PUBLISH_INVALID_USER_TAG",
    severity: "error",
    retryable: false,
    problem: "Belgilangan foydalanuvchi topilmadi yoki yopiq akkaunt.",
    cause: "Instagram faqat ochiq akkauntlarni belgilashga ruxsat beradi.",
    solution: "Username'ni tuzating yoki belgini olib tashlang, so'ng qayta rejalashtiring.",
    action: { kind: "check_settings", label: "Postni tahrirlash" },
  },
  PUBLISH_INVALID_COLLABORATOR: {
    code: "PUBLISH_INVALID_COLLABORATOR",
    severity: "error",
    retryable: false,
    problem: "Hammuallif topilmadi yoki yopiq akkaunt.",
    cause: "Instagram faqat ochiq akkauntlarni hammuallif qila oladi.",
    solution: "Username'ni tuzating yoki hammuallifni olib tashlang.",
    action: { kind: "check_settings", label: "Postni tahrirlash" },
  },
  PUBLISH_PPA_REQUIRED: {
    code: "PUBLISH_PPA_REQUIRED",
    severity: "error",
    retryable: false,
    problem: "Instagram ilovasida tasdiqlash talab qilinmoqda.",
    cause: "Akkaunt uchun Page Publishing Authorization yoqilgan.",
    solution: "Instagram / Facebook ilovasida tasdiqlashni o'ting, keyin qayta uriniladi.",
    action: { kind: "check_settings", label: "Ko'rsatma" },
  },
  PUBLISH_ACCOUNT_RESTRICTED: {
    code: "PUBLISH_ACCOUNT_RESTRICTED",
    severity: "error",
    retryable: false,
    problem: "Akkaunt API orqali post chiqara olmaydi.",
    cause: "Instagram akkauntni vaqtincha cheklagan.",
    solution: "Avval Instagram ilovasidan qo'lda post qilib ko'ring; post qo'lda e'lon rejimiga o'tkazildi.",
    action: NONE,
  },
  PUBLISH_LATE: {
    code: "PUBLISH_LATE",
    severity: "warning",
    retryable: true,
    problem: "Vaqt o'tib ketdi — post avtomatik chiqarilmadi.",
    cause: "Server yoki navbat rejalashtirilgan vaqtdan 15 daqiqadan ko'p kechikdi.",
    solution: "Hozir chiqarish uchun \"Qayta urinish\" tugmasini bosing yoki yangi vaqt tanlang.",
    action: { kind: "retry", label: "Hozir chiqarish" },
  },
  PUBLISH_UNKNOWN: {
    code: "PUBLISH_UNKNOWN",
    severity: "error",
    retryable: true,
    problem: "Vaqtinchalik xato — post chiqmadi.",
    cause: "Instagram yoki tarmoq vaqtincha javob bermadi.",
    solution: "30 soniya, 2 va 10 daqiqadan keyin avtomatik qayta uriniladi.",
    action: { kind: "retry", label: "Qayta urinish" },
  },
  FIRST_COMMENT_FAILED: {
    code: "FIRST_COMMENT_FAILED",
    severity: "warning",
    retryable: true,
    problem: "Post chiqdi, birinchi komment yozilmadi.",
    cause: "Komment so'rovi 3 urinishda ham o'tmadi.",
    solution: "Post sahifasida kommentni qayta yuboring.",
    action: { kind: "retry", label: "Kommentni qayta yuborish" },
  },
  CAMPAIGN_LINK_FAILED: {
    code: "CAMPAIGN_LINK_FAILED",
    severity: "critical",
    retryable: true,
    problem: "Post chiqdi, lekin kampaniya ulanmadi — DM lar yo'qolishi mumkin.",
    cause: "Kampaniyani yangilash paytida ma'lumotlar bazasi xatosi.",
    solution: "Kampaniyani postga qo'lda ulang (Kampaniyalar → post tanlash).",
    action: { kind: "check_settings", label: "Kampaniyani ulash" },
  },
  UNKNOWN: {
    code: "UNKNOWN",
    severity: "error",
    retryable: false,
    problem: "Kutilmagan xato yuz berdi.",
    cause: "Tizim bu xatoni taniy olmadi.",
    solution: "Takrorlansa — quyidagi texnik ma'lumotni dasturchiga yuboring.",
    action: { kind: "recheck", label: "Qayta tekshirish" },
  },
} satisfies Record<string, Entry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

// ── Matching ─────────────────────────────────────────────────────────────────

// Order matters: a specific Meta rejection wins over the generic class.
const TEXT_RULES: Array<[ErrorCode, RegExp]> = [
  // CRM credentials rejected (lib/integrations IntegrationAuthError, markIntegrationBroken's event text).
  [
    "INTEGRATION_AUTH_EXPIRED",
    /IntegrationAuthError|amocrm responded 40[13]|bitrix24 auth failed|integratsiyasi uzildi/i,
  ],
  ["IG_DISCONNECTED", /disconnected by user|no instagram access token/i],
  ["IG_APP_REMOVED", /deauthorize|app removed in instagram|has not authorized application/i],
  ["IG_TOKEN_UNREADABLE", /cannot be decrypted|could not decrypt|failed to decrypt/i],
  ["IG_WINDOW_CLOSED", /outside of allowed window|2534022/i],
  ["IG_USER_NOT_FOUND", /requested user cannot be found|no matching user found|2534014/i],
  ["IG_PRIVATE_REPLY_USED", /one private reply|already sent the one/i],
  ["APP_HOURLY_DM_LIMIT", /hourly (instagram dm )?rate limit/i],
  ["PLAN_LIMIT", /monthly dm limit reached/i],
  ["WORKSPACE_SUSPENDED", /workspace suspended/i],
  ["WEBHOOK_SIGNATURE", /signature cannot be verified/i],
];

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|AbortError|network/i;

/** Which token problem a Meta 190 (or a stored token reason) is. */
export function tokenErrorCode(subcode: number | undefined, text: string): ErrorCode {
  if (subcode === 458) return "IG_APP_REMOVED";
  if (subcode === 459) return "IG_ACCOUNT_CHECKPOINT";
  if (subcode === 460) return "IG_PASSWORD_CHANGED";
  if (subcode === 463) return "IG_TOKEN_EXPIRED";
  if (subcode === 464) return "IG_ACCOUNT_UNCONFIRMED";
  if (subcode === 467) return "IG_TOKEN_INVALID";
  // No subcode (graph.instagram.com often omits it): Meta's wording decides.
  if (/session has expired|has expired|token.*expired/i.test(text)) return "IG_TOKEN_EXPIRED";
  if (/changed (their|the) password|password.*changed/i.test(text)) return "IG_PASSWORD_CHANGED";
  if (/checkpoint/i.test(text)) return "IG_ACCOUNT_CHECKPOINT";
  if (/not a confirmed user|not confirmed|unconfirmed/i.test(text)) return "IG_ACCOUNT_UNCONFIRMED";
  if (/not authorized application|deauthoriz/i.test(text)) return "IG_APP_REMOVED";
  return "IG_TOKEN_INVALID";
}

function classify(input: unknown, text: string): ErrorCode {
  if (input instanceof IntegrationAuthError) return "INTEGRATION_AUTH_EXPIRED";
  // Content Scheduler codes are stored verbatim on the post (lastErrorCode / attempt message).
  const publishCode = text.match(/\b(PUBLISH_[A-Z_]+|FIRST_COMMENT_FAILED|CAMPAIGN_LINK_FAILED)\b/)?.[1];
  if (publishCode && publishCode in ERROR_CATALOG) return publishCode as ErrorCode;
  for (const [code, pattern] of TEXT_RULES) {
    if (pattern.test(text)) return code;
  }

  const { code, subcode } = codesOf(input, text);

  const oauthTokenText = /OAuthException/i.test(text) && /access token/i.test(text);
  if (code === 190 || input instanceof TokenExpiredError || oauthTokenText) {
    return tokenErrorCode(subcode, text);
  }
  if (subcode === 2534022) return "IG_WINDOW_CLOSED";
  if (subcode === 2534014) return "IG_USER_NOT_FOUND";
  if (code === 551) return "IG_USER_UNAVAILABLE";
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 368 || input instanceof RateLimitError) {
    return "IG_RATE_LIMIT";
  }
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return "IG_PERMISSION";
  // A PermissionError without Meta's tail (code 100 is only the class default)
  // came from 10/100/200 — treat it as permission; a real 100 is a bad param.
  if (code === 100) {
    return input instanceof PermissionError && parseMetaCodes(text).code === undefined
      ? "IG_PERMISSION"
      : "IG_INVALID_PARAMETER";
  }
  if (input instanceof PermissionError) return "IG_PERMISSION";
  if (code === 1 || code === 2 || (code !== undefined && code >= 500 && code <= 599)) return "IG_TEMPORARY";
  if (NETWORK.test(text) || (input instanceof Error && input.name === "AbortError")) return "NETWORK_ERROR";
  if (input instanceof MetaApiError) return "IG_TEMPORARY";
  return "UNKNOWN";
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function explainError(
  input: unknown,
  context: { timestamp?: Date | string | null; related?: RelatedObject } = {}
): ExplainedError {
  const text = rawText(input);
  const entry: Entry = ERROR_CATALOG[classify(input, text)];
  return {
    ...entry,
    technical: technicalText(input).slice(0, 1000) || "—",
    ...(toIso(context.timestamp) ? { timestamp: toIso(context.timestamp) } : {}),
    ...(context.related ? { related: context.related } : {}),
  };
}
