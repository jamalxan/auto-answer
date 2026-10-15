/**
 * Instagram connection status (TZ §4.1) from the stored account fields.
 *
 * Before this, "Connected" meant "a row exists" (later: tokenStatus=ACTIVE).
 * Here the raw fields are folded into one of the seven statuses the spec
 * requires, with a reason and the one action that fixes it. Pure — the
 * checks that keep the fields fresh live in lib/meta/token-health.
 *
 * Rules, first match wins:
 *
 *   accessToken ""                                  → DISCONNECTED
 *     (…but removed by Meta's deauthorize callback) → RECONNECT_REQUIRED
 *   tokenExpiresAt in the past                      → EXPIRED
 *   BROKEN, reason = 190/463 or "expired"           → EXPIRED
 *   BROKEN, reason = 190/458·459·460·464            → RECONNECT_REQUIRED
 *     (app removed, checkpoint, password changed, unconfirmed account)
 *   BROKEN, reason = 190/467, undecryptable, other 190 → INVALID
 *   BROKEN, anything else                           → ERROR
 *   ACTIVE, last check > 24h ago                    → ERROR (status unknown)
 *   ACTIVE, expires within 10 days                  → EXPIRING
 *   otherwise                                       → CONNECTED
 */

import type { DisplayTone } from "@/lib/triggers/display";
import { parseMetaCodes, tokenErrorCode } from "./error-catalog";
import { toDate } from "./time";

export type ConnectionStatus =
  | "CONNECTED"
  | "EXPIRING"
  | "EXPIRED"
  | "INVALID"
  | "RECONNECT_REQUIRED"
  | "ERROR"
  | "DISCONNECTED";

export type ConnectionActionKind = "reconnect" | "recheck" | "none";

export interface ConnectionFields {
  accessToken: string | null;
  tokenExpiresAt: Date | string | null;
  tokenStatus: string;
  tokenCheckedAt: Date | string | null;
  tokenLastError: string | null;
  /** Fallback for "last verified" on a row that was never checked. */
  connectedAt?: Date | string | null;
}

export interface DerivedConnection {
  status: ConnectionStatus;
  tone: DisplayTone;
  title: string;
  explanation: string;
  action: { kind: ConnectionActionKind; label: string };
  /** Whole days until tokenExpiresAt; null when unknown. Negative = expired. */
  expiresInDays: number | null;
}

export const EXPIRING_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;
/** token-health runs every ~6h; a day without a check means it stopped. */
export const STALE_CHECK_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const RECONNECT = { kind: "reconnect", label: "Qayta ulash" } as const;
const RECHECK = { kind: "recheck", label: "Qayta tekshirish" } as const;
const NONE = { kind: "none", label: "" } as const;

type BrokenKind = "expired" | "reconnect" | "invalid" | "unknown";

const RECONNECT_REASONS: Record<string, string> = {
  IG_APP_REMOVED: "Instagram sozlamalarida SocialAuto'ga berilgan ruxsat bekor qilingan.",
  IG_ACCOUNT_CHECKPOINT: "Meta akkauntni tekshiruvga (checkpoint) qo'ygan — avval Instagram'ga kirib tasdiqlang.",
  IG_PASSWORD_CHANGED: "Instagram paroli o'zgargan yoki Meta sessiyani xavfsizlik sababli yopgan.",
  IG_ACCOUNT_UNCONFIRMED: "Akkaunt Meta talab qilgan tasdiqlashdan o'tmagan.",
};

/** What a stored tokenLastError says about the token. Exported for tests. */
export function classifyBrokenReason(reason: string | null): { kind: BrokenKind; code?: string } {
  const text = reason ?? "";
  if (/cannot be decrypted|could not decrypt|failed to decrypt/i.test(text)) return { kind: "invalid", code: "IG_TOKEN_UNREADABLE" };
  if (/deauthorize|app removed in instagram/i.test(text)) return { kind: "reconnect", code: "IG_APP_REMOVED" };

  const { code, subcode } = parseMetaCodes(text);
  const looksLikeToken =
    code === 190 ||
    (subcode !== undefined && [458, 459, 460, 463, 464, 467].includes(subcode)) ||
    /TokenExpiredError|access token|session/i.test(text);
  if (!looksLikeToken) return { kind: "unknown" };

  const tokenCode = tokenErrorCode(subcode, text);
  if (tokenCode === "IG_TOKEN_EXPIRED") return { kind: "expired", code: tokenCode };
  if (tokenCode in RECONNECT_REASONS) return { kind: "reconnect", code: tokenCode };
  return { kind: "invalid", code: tokenCode };
}

export function deriveConnectionStatus(account: ConnectionFields, now: Date = new Date()): DerivedConnection {
  const expiresAt = toDate(account.tokenExpiresAt);
  const expiresInDays = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
  const base = { expiresInDays };

  if (!account.accessToken) {
    if (/deauthorize|app removed in instagram/i.test(account.tokenLastError ?? "")) {
      return {
        ...base,
        status: "RECONNECT_REQUIRED",
        tone: "error",
        title: "Qayta ulash kerak",
        explanation: RECONNECT_REASONS.IG_APP_REMOVED,
        action: RECONNECT,
      };
    }
    return {
      ...base,
      status: "DISCONNECTED",
      tone: "muted",
      title: "Uzilgan",
      explanation: "Akkaunt SocialAuto'dan uzilgan. Kampaniyalar va assistent bu akkauntda ishlamaydi.",
      action: RECONNECT,
    };
  }

  const expired = {
    ...base,
    status: "EXPIRED",
    tone: "error",
    title: "Muddati tugagan",
    explanation: "Instagram access token amal qilish muddatini tugatgan. Xabarlar yuborilmayapti.",
    action: RECONNECT,
  } as const;

  if (expiresAt && expiresAt.getTime() <= now.getTime()) return expired;

  if (account.tokenStatus === "BROKEN") {
    const { kind, code } = classifyBrokenReason(account.tokenLastError);
    if (kind === "expired") return expired;
    if (kind === "reconnect") {
      return {
        ...base,
        status: "RECONNECT_REQUIRED",
        tone: "error",
        title: "Qayta ulash kerak",
        explanation: RECONNECT_REASONS[code ?? ""] ?? "Instagram ulanishni bekor qilgan.",
        action: RECONNECT,
      };
    }
    if (kind === "invalid") {
      return {
        ...base,
        status: "INVALID",
        tone: "error",
        title: "Yaroqsiz token",
        explanation:
          code === "IG_TOKEN_UNREADABLE"
            ? "Saqlangan tokenni o'qib bo'lmadi (shifrlash kaliti o'zgargan bo'lishi mumkin)."
            : "Instagram saqlangan tokenni qabul qilmadi.",
        action: RECONNECT,
      };
    }
    return {
      ...base,
      status: "ERROR",
      tone: "error",
      title: "Xato",
      explanation: "Ulanish ishlamayapti, sababi aniqlanmadi. Qayta tekshiring; takrorlansa — qayta ulang.",
      action: RECHECK,
    };
  }

  const checkedAt = toDate(account.tokenCheckedAt) ?? toDate(account.connectedAt);
  if (!checkedAt || now.getTime() - checkedAt.getTime() > STALE_CHECK_MS) {
    return {
      ...base,
      status: "ERROR",
      tone: "warning",
      title: "Tekshirilmagan",
      explanation: "Token 24 soatdan beri tekshirilmagan — haqiqiy holati noma'lum. Qayta tekshiring.",
      action: RECHECK,
    };
  }

  if (expiresAt && expiresAt.getTime() - now.getTime() <= EXPIRING_WITHIN_MS) {
    return {
      ...base,
      status: "EXPIRING",
      tone: "warning",
      title: "Muddati tugayapti",
      explanation: `Token ${Math.max(expiresInDays ?? 0, 0)} kundan keyin tugaydi va avtomatik yangilanmadi. Qayta ulash muddatni 60 kunga uzaytiradi.`,
      action: RECONNECT,
    };
  }

  return {
    ...base,
    status: "CONNECTED",
    tone: "success",
    title: "Ulangan",
    explanation: "Token ishlayapti va Instagram uni qabul qilyapti.",
    action: NONE,
  };
}
