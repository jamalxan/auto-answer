/**
 * ETAP 11 — read-only ManyChat Page API client.
 *
 *  - the base URL is a constant (`https://api.manychat.com`), never built from
 *    user input; paths are a fixed list; redirects are refused;
 *  - `Authorization: Bearer <key>`; the key is never logged, never put in an
 *    error message and never returned;
 *  - GET only: getInfo, getTags, getCustomFields, getBotFields, getGrowthTools,
 *    getFlows. ManyChat allows 10 requests per second; we stay at 8;
 *  - timeout 10 s; 5xx is retried twice, 429 once (when Retry-After is short);
 *  - tolerant parsing (see manychat-types.ts: shapes are UNVERIFIED).
 *
 * `fetchImpl`, `sleep` and `now` are injectable so tests need no network or timers.
 */

import {
  envelopeSchema,
  type ManychatBotField,
  type ManychatCustomField,
  type ManychatFlow,
  type ManychatGrowthTool,
  type ManychatPageInfo,
  type ManychatTag,
  normalizeBotFields,
  normalizeCustomFields,
  normalizeFlows,
  normalizeGrowthTools,
  normalizePageInfo,
  normalizeTags,
} from "./manychat-types";

export const MANYCHAT_BASE_URL = "https://api.manychat.com";
export const MANYCHAT_TIMEOUT_MS = 10_000;
/** 8 requests per second (ManyChat's limit is 10). */
export const MANYCHAT_MIN_INTERVAL_MS = 125;
const SERVER_RETRY_DELAYS_MS = [400, 1200];
const MAX_RETRY_AFTER_S = 5;

const PATHS = {
  info: "/fb/page/getInfo",
  tags: "/fb/page/getTags",
  customFields: "/fb/page/getCustomFields",
  botFields: "/fb/page/getBotFields",
  growthTools: "/fb/page/getGrowthTools",
  flows: "/fb/page/getFlows",
} as const;

export type ManychatErrorKind = "auth" | "rate_limit" | "server" | "network" | "timeout" | "not_found" | "bad_response";

export class ManychatError extends Error {
  constructor(
    public readonly kind: ManychatErrorKind,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterSec: number | null = null
  ) {
    super(message);
    this.name = "ManychatError";
  }
}

export const MANYCHAT_MESSAGES = {
  auth: "ManyChat API kaliti noto'g'ri yoki ruxsati yo'q. ManyChat → Settings → API bo'limidan yangi kalit oling (Pro tarif kerak).",
  rate_limit: "ManyChat so'rovlar chegarasiga yetdi — bir necha soniyadan keyin qayta urinib ko'ring",
  server: "ManyChat serveri javob bermadi (5xx) — birozdan keyin qayta urinib ko'ring",
  network: "ManyChat bilan aloqa o'rnatilmadi — internet yoki ManyChat holatini tekshiring",
  timeout: "ManyChat 10 soniyada javob bermadi — qayta urinib ko'ring",
  not_found: "ManyChat bu ma'lumotni qaytarmadi (bu API bo'limi akkauntingizda mavjud emas)",
  bad_response: "ManyChat kutilmagan javob qaytardi",
} as const;

export interface ManychatClient {
  getInfo(): Promise<ManychatPageInfo>;
  getTags(): Promise<ManychatTag[]>;
  getCustomFields(): Promise<ManychatCustomField[]>;
  getBotFields(): Promise<ManychatBotField[]>;
  getGrowthTools(): Promise<ManychatGrowthTool[]>;
  getFlows(): Promise<ManychatFlow[]>;
}

export interface ManychatClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keys are opaque tokens; header injection and absurd values are refused before any request. */
export function isPlausibleApiKey(key: string): boolean {
  return key.length >= 8 && key.length <= 300 && /^[\x21-\x7e]+$/.test(key);
}

export function createManychatClient(options: ManychatClientOptions): ManychatClient {
  const apiKey = options.apiKey.trim();
  if (!isPlausibleApiKey(apiKey)) throw new ManychatError("auth", MANYCHAT_MESSAGES.auth);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MANYCHAT_TIMEOUT_MS;
  let lastAt = Number.NEGATIVE_INFINITY;

  const throttle = async () => {
    const wait = lastAt + MANYCHAT_MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
  };

  const retryAfterOf = (response: Response): number | null => {
    const raw = response.headers?.get?.("retry-after");
    const seconds = raw ? Number(raw) : NaN;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  };

  async function get(path: (typeof PATHS)[keyof typeof PATHS]): Promise<unknown> {
    let serverRetries = 0;
    let rateRetries = 0;
    for (;;) {
      await throttle();
      let response: Response;
      try {
        response = await fetchImpl(`${MANYCHAT_BASE_URL}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") throw new ManychatError("timeout", MANYCHAT_MESSAGES.timeout);
        throw new ManychatError("network", MANYCHAT_MESSAGES.network);
      }

      if (response.status === 401 || response.status === 403) throw new ManychatError("auth", MANYCHAT_MESSAGES.auth, response.status);
      if (response.status === 404) throw new ManychatError("not_found", MANYCHAT_MESSAGES.not_found, 404);
      if (response.status === 429) {
        const retryAfter = retryAfterOf(response);
        if (rateRetries < 1 && retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_S) {
          rateRetries += 1;
          await sleep(Math.max(retryAfter, 0.2) * 1000);
          continue;
        }
        throw new ManychatError("rate_limit", MANYCHAT_MESSAGES.rate_limit, 429, retryAfter);
      }
      if (response.status >= 500) {
        if (serverRetries < SERVER_RETRY_DELAYS_MS.length) {
          await sleep(SERVER_RETRY_DELAYS_MS[serverRetries]);
          serverRetries += 1;
          continue;
        }
        throw new ManychatError("server", MANYCHAT_MESSAGES.server, response.status);
      }
      if (!response.ok) throw new ManychatError("bad_response", `${MANYCHAT_MESSAGES.bad_response} (HTTP ${response.status})`, response.status);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ManychatError("bad_response", MANYCHAT_MESSAGES.bad_response, response.status);
      }
      const envelope = envelopeSchema.safeParse(body);
      if (!envelope.success) throw new ManychatError("bad_response", MANYCHAT_MESSAGES.bad_response, response.status);
      const status = envelope.data.status;
      if (status && status !== "success") {
        // ManyChat reports an invalid token as 200 + status "error" in some endpoints.
        if (/token|auth|unauthor|forbidden|api key/i.test(`${envelope.data.message ?? ""}`)) throw new ManychatError("auth", MANYCHAT_MESSAGES.auth, response.status);
        throw new ManychatError("bad_response", MANYCHAT_MESSAGES.bad_response, response.status);
      }
      return envelope.data.data;
    }
  }

  return {
    getInfo: async () => normalizePageInfo(await get(PATHS.info)),
    getTags: async () => normalizeTags(await get(PATHS.tags)),
    getCustomFields: async () => normalizeCustomFields(await get(PATHS.customFields)),
    getBotFields: async () => normalizeBotFields(await get(PATHS.botFields)),
    getGrowthTools: async () => normalizeGrowthTools(await get(PATHS.growthTools)),
    getFlows: async () => normalizeFlows(await get(PATHS.flows)),
  };
}
