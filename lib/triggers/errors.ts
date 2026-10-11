/**
 * Send failures → what the admin sees, what the backend keeps, and whether a
 * retry can help.
 *
 * The UI shows `userMessage` ("Instagram API vaqtincha javob bermadi"), the
 * log keeps `technical` (Meta's message, code and trace id), and `retryable`
 * decides between "Queued for retry" and a final failure.
 */

import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

export type SendFailureKind =
  | "rate_limit"
  | "token"
  | "permission"
  | "window_closed"
  | "user_gone"
  | "temporary"
  | "unknown";

export interface ClassifiedFailure {
  kind: SendFailureKind;
  retryable: boolean;
  userMessage: string;
  technical: string;
}

// Rejections no retry can fix: the 24-hour messaging window only closes, and
// a deleted / unreachable account stays that way.
const WINDOW_CLOSED = [/outside of allowed window/i, /2534022/];
const USER_GONE = [/requested user cannot be found/i, /no matching user found/i, /2534014/];

function describe(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `${error.name} code=${error.code}${error.subcode ? ` sub=${error.subcode}` : ""}: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export class TriggerRetryableError extends Error {
  constructor(public readonly failure: ClassifiedFailure) {
    super(failure.technical);
    this.name = "TriggerRetryableError";
  }
}

export function classifySendError(error: unknown): ClassifiedFailure {
  const technical = describe(error).slice(0, 2000);
  const message = error instanceof Error ? error.message : String(error);

  if (WINDOW_CLOSED.some((p) => p.test(message))) {
    return {
      kind: "window_closed",
      retryable: false,
      userMessage: "Instagram 24 soatlik xabar oynasi yopilgan — bu odamga endi yozib bo'lmaydi.",
      technical,
    };
  }
  if (USER_GONE.some((p) => p.test(message))) {
    return {
      kind: "user_gone",
      retryable: false,
      userMessage: "Foydalanuvchi topilmadi (akkaunt o'chirilgan yoki yopiq).",
      technical,
    };
  }
  if (error instanceof TokenExpiredError) {
    return {
      kind: "token",
      retryable: false,
      userMessage: "Instagram ulanishi eskirgan — akkauntni qayta ulang.",
      technical,
    };
  }
  if (error instanceof RateLimitError) {
    return {
      kind: "rate_limit",
      retryable: true,
      userMessage: "Instagram limitiga yetildi — birozdan keyin qayta yuboriladi.",
      technical,
    };
  }
  if (error instanceof PermissionError) {
    return {
      kind: "permission",
      retryable: false,
      userMessage: "Instagram bu xabarni yuborishga ruxsat bermadi.",
      technical,
    };
  }
  if (error instanceof MetaApiError) {
    // Meta's own "temporary" codes (1, 2) and server-side errors; anything
    // else unknown still gets the bounded retries — better than giving up on a
    // message Meta may well accept a minute later.
    return {
      kind: "temporary",
      retryable: true,
      userMessage: "Instagram API vaqtincha javob bermadi.",
      technical,
    };
  }
  // fetch failures (DNS, reset, timeout) land here.
  return {
    kind: "temporary",
    retryable: true,
    userMessage: "Instagram API vaqtincha javob bermadi.",
    technical,
  };
}
