/**
 * Log redaction (audit 2026-10-26, T7): tokens, secrets, phone numbers and
 * e-mails never reach a log line or an error response. Two layers:
 *
 *   - redactText / redactValue for code that builds its own messages
 *   - installConsoleRedaction() wraps console.* once per process (web via
 *     instrumentation.ts, worker at start), so a forgotten console.error(err)
 *     with a Graph URL inside is still masked
 *
 * Masking keeps a short tail ("…a1b2") so two log lines can still be
 * correlated without the value being usable.
 */

const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|token|secret|client_?secret|app_?secret|password|passwd|api_?key|apikey|authorization|cookie|set-cookie|encrypted_?payload|dek_?encrypted|kek|private_?key)$/i;
const PII_KEYS = /^(phone|phone_?e164|phone_?raw|telefon|email|e_?mail)$/i;

const tail = (s: string, n = 4) => (s.length > n * 3 ? `…${s.slice(-n)}` : "");

const PATTERNS: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // key=value in URLs, query strings and form bodies
  [/\b(access_token|refresh_token|client_secret|fb_exchange_token|input_token|appsecret_proof|api_key|apikey|key|token|secret|password)=([^&\s"'<>]+)/gi, (_m, k: string, v: string) => `${k}=[redacted${tail(v)}]`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, (m) => `Bearer [redacted${tail(m)}]`],
  // Meta (Facebook / Instagram) tokens
  [/\b(EAA[A-Za-z0-9]{20,}|IGQ[A-Za-z0-9_-]{20,}|IGAA[A-Za-z0-9_-]{20,}|IGAB[A-Za-z0-9_-]{20,})/g, (m) => `[meta-token${tail(m)}]`],
  // Telegram bot token 123456:ABC…
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, (m) => `[bot-token${tail(m)}]`],
  // Google OAuth / API keys
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, (m) => `[google-token${tail(m)}]`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, (m) => `[google-key${tail(m)}]`],
  // LLM vendor keys
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, (m) => `[api-key${tail(m)}]`],
  // e-mail: keep the domain
  [/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first: string, domain: string) => `${first}***@${domain}`],
  // phone numbers: anything written with "+" (+998 90 123 45 67, +7 (999) 123-45-67) and bare Uzbek
  // 998XXXXXXXXX — keep the last two digits. Bare 10-digit numbers stay (they are usually timestamps / ids).
  [/(?<![\w+])\+\d[\d\s().-]{7,16}\d(?![\w])/g, (m) => `[phone…${m.replace(/\D/g, "").slice(-2)}]`],
  [/(?<![\w.])998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\w])/g, (m) => `[phone…${m.replace(/\D/g, "").slice(-2)}]`],
];

export function redactText(input: string): string {
  let out = input;
  for (const [re, fn] of PATTERNS) out = out.replace(re, fn as (substring: string, ...args: unknown[]) => string);
  return out;
}

/** Deep copy with secret / PII keys masked and every string run through redactText. */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[…]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const copy = new Error(redactText(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactText(value.stack) : undefined;
    return copy;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) out[k] = v ? "[redacted]" : v;
    else if (PII_KEYS.test(k) && typeof v === "string") out[k] = redactText(v) === v ? `${v.slice(0, 1)}***` : redactText(v);
    else out[k] = redactValue(v, depth + 1, seen);
  }
  return out;
}

const INSTALLED = Symbol.for("socialauto.consoleRedaction");

/** Idempotent: wraps console.log/info/warn/error/debug so every argument is redacted. */
export function installConsoleRedaction(target: Console = console): void {
  const flagged = target as Console & { [INSTALLED]?: boolean };
  if (flagged[INSTALLED]) return;
  flagged[INSTALLED] = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      try {
        original(...args.map((a) => redactValue(a)));
      } catch {
        original(...args);
      }
    };
  }
}
