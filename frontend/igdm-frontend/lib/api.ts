/**
 * Thin client for igdm-backend (FastAPI).
 * Endpoints match app/routers/* exactly:
 *   POST /api/auth/login · GET /api/accounts · DELETE /api/accounts/{id}
 *   GET|POST|PATCH|DELETE /api/campaigns · /api/campaigns/{id}/preview|test|duplicate
 *   GET /api/media · GET /api/events · GET /api/leads · GET /api/leads/export
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "igdm_token";

export function getToken() {
  return typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
export function isAuthed() {
  return !!getToken();
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (res.status === 401 && path !== "/api/auth/login") {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
  }

  if (!res.ok) {
    // Errors say what broke and what to do next — the message is shown as-is.
    const detail = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      detail?.detail ??
        (res.status === 401
          ? "Sessiya tugagan. Qaytadan kiring."
          : "Server javob bermadi. Bir daqiqadan so'ng qayta urinib ko'ring.")
    );
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/* ── types, mirroring app/schemas/*.py ── */

export type Account = {
  id: string;
  ig_user_id: string;
  ig_username: string;
  status: string;
  webhook_subscribed: boolean;
  token_expires_at: string | null;
  connected_at: string;
};

export type Keyword = { keyword: string; is_negative: boolean };

export type QuickReply = { label: string; payload: string };

export type Template = {
  step: "public_reply" | "opening" | "gate" | "reward" | "retry" | "decline";
  body: string;
  quick_replies: QuickReply[];
  sort_order: number;
};

export type MediaTarget = {
  ig_media_id: string;
  media_type?: string | null;
  permalink?: string | null;
  thumbnail_url?: string | null;
};

export type Campaign = {
  id: string;
  account_id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  priority: number;
  target_mode: "specific" | "all";
  reply_enabled: boolean;
  match_mode: "exact" | "contains" | "word";
  case_insensitive: boolean;
  cyrillic_normalise: boolean;
  gate_strategy: "none" | "self_confirm" | "external_db" | "engagement";
  gate_config: Record<string, unknown>;
  reward_link: string;
  cooldown_hours: number;
  gate_max_retries: number;
  abandon_after_days: number;
  created_at: string;
  updated_at: string;
  keywords: Keyword[];
  templates: Template[];
};

export type CampaignEvent = {
  id: string;
  campaign_id: string | null;
  ig_comment_id: string;
  ig_media_id: string;
  ig_user_id: string;
  ig_username: string | null;
  comment_text: string;
  matched_keyword: string | null;
  match_result: "matched" | "no_match" | "self_comment" | "spam_guard" | "duplicate" | "cooldown";
  public_reply_status: "pending" | "sent" | "failed" | "disabled" | "skipped";
  public_reply_error: string | null;
  received_at: string;
  processed_at: string | null;
};

export type Lead = {
  id: string;
  campaign_id: string;
  ig_user_id: string;
  ig_username: string | null;
  first_triggered_at: string;
  completed_at: string | null;
  gate_result: "pass" | "fail" | "pending" | "not_applicable";
  link_delivered: boolean;
  link_clicked_at: string | null;
};

export type MediaItem = {
  ig_media_id: string;
  caption?: string | null;
  media_type?: string | null;
  permalink?: string | null;
  thumbnail_url?: string | null;
};

export type TestResult = {
  matched: boolean;
  matched_keyword: string | null;
  reason: string;
  would_send_public_reply: boolean;
  would_open_dm_to: string | null;
  gate_strategy: string;
  note: string;
};

/* ── auth ── */

export const login = (email: string, password: string) =>
  api<{ access_token: string; token_type: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const requestRegisterOtp = (email: string) =>
  api<void>("/api/auth/register/request-otp", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const registerVerify = (email: string, code: string, password: string) =>
  api<{ access_token: string; token_type: string }>("/api/auth/register/verify", {
    method: "POST",
    body: JSON.stringify({ email, code, password }),
  });

/* ── accounts ── */

export const getAccounts = () => api<Account[]>("/api/accounts");
export const connectAccount = (code: string) =>
  api<Account>("/api/accounts/connect", { method: "POST", body: JSON.stringify({ code }) });
export const disconnectAccount = (id: string) => api<void>(`/api/accounts/${id}`, { method: "DELETE" });

/* ── campaigns ── */

export const getCampaigns = (accountId?: string) =>
  api<Campaign[]>(`/api/campaigns${accountId ? `?account_id=${accountId}` : ""}`);
export const getCampaign = (id: string) => api<Campaign>(`/api/campaigns/${id}`);
export const createCampaign = (body: Record<string, unknown>) =>
  api<Campaign>("/api/campaigns", { method: "POST", body: JSON.stringify(body) });
export const patchCampaign = (id: string, body: Record<string, unknown>) =>
  api<Campaign>(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteCampaign = (id: string) => api<void>(`/api/campaigns/${id}`, { method: "DELETE" });
export const duplicateCampaign = (id: string) =>
  api<Campaign>(`/api/campaigns/${id}/duplicate`, { method: "POST" });
export const previewCampaign = (id: string) =>
  api<{ step: string; body: string; quick_replies: QuickReply[] }[]>(`/api/campaigns/${id}/preview`);
export const testCampaign = (
  id: string,
  body: { ig_user_id: string; ig_username?: string; comment_text: string }
) => api<TestResult>(`/api/campaigns/${id}/test`, { method: "POST", body: JSON.stringify(body) });

/* ── events / leads / media ── */

export const getEvents = (params: Record<string, string | number | undefined> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const qs = q.toString();
  return api<CampaignEvent[]>(`/api/events${qs ? `?${qs}` : ""}`);
};

export const getLeads = (campaignId?: string) =>
  api<Lead[]>(`/api/leads${campaignId ? `?campaign_id=${campaignId}` : ""}`);

export const getMedia = (accountId: string) => api<MediaItem[]>(`/api/media?account_id=${accountId}`);

export async function exportLeadsCsv(campaignId?: string) {
  const res = await fetch(`${BASE}/api/leads/export${campaignId ? `?campaign_id=${campaignId}` : ""}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, "Eksport qilib bo'lmadi.");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "leads_export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
