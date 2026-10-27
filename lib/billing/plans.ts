/**
 * Tariffs (audit 2026-10-26, "Monetizatsiya"): priced by channels + AI
 * replies + video analyses, not by Instagram accounts. The numbers are the
 * audit's hypothesis, to be tested with the first ten paying customers, so
 * every limit and price can be overridden from the environment without a
 * deploy (PLAN_LIMITS_JSON, PLAN_PRICES_UZS_JSON).
 *
 * Paid in so'm through Click / Payme. "aiReplies" is enforced on the existing
 * AI-conversation meter (one unit per conversation the AI answered).
 */

export const PLAN_SLUGS = ["start", "biznes", "pro", "agentlik"] as const;
export type PlanSlug = (typeof PLAN_SLUGS)[number];

export interface PlanLimits {
  /** Instagram + Facebook + Threads + YouTube + Telegram channels together. */
  channels: number;
  aiReplies: number;
  /** AI auto mode (trust ladder AUTO); Start is observe + copilot only. */
  aiAuto: boolean;
  managers: number;
  scheduledPostsPerMonth: number;
  videoAnalysesPerMonth: number;
  contentPlan: boolean;
  crmIntegrations: boolean;
  clientReports: boolean;
}

export interface Plan {
  slug: PlanSlug;
  name: string;
  priceUsd: number;
  audience: string;
  limits: PlanLimits;
}

const DEFAULTS: Record<PlanSlug, Plan> = {
  start: {
    slug: "start",
    name: "Start",
    priceUsd: 0,
    audience: "Sinab ko'rish",
    limits: { channels: 1, aiReplies: 50, aiAuto: false, managers: 1, scheduledPostsPerMonth: 10, videoAnalysesPerMonth: 0, contentPlan: false, crmIntegrations: false, clientReports: false },
  },
  biznes: {
    slug: "biznes",
    name: "Biznes",
    priceUsd: 29,
    audience: "Kichik biznes",
    limits: { channels: 3, aiReplies: 1000, aiAuto: true, managers: 1, scheduledPostsPerMonth: 300, videoAnalysesPerMonth: 10, contentPlan: true, crmIntegrations: false, clientReports: false },
  },
  pro: {
    slug: "pro",
    name: "Pro",
    priceUsd: 79,
    audience: "O'rta biznes",
    limits: { channels: 6, aiReplies: 5000, aiAuto: true, managers: 3, scheduledPostsPerMonth: 1000, videoAnalysesPerMonth: 40, contentPlan: true, crmIntegrations: true, clientReports: false },
  },
  agentlik: {
    slug: "agentlik",
    name: "Agentlik",
    priceUsd: 199,
    audience: "Agentliklar",
    limits: { channels: 25, aiReplies: 20000, aiAuto: true, managers: 10, scheduledPostsPerMonth: 5000, videoAnalysesPerMonth: 150, contentPlan: true, crmIntegrations: true, clientReports: true },
  },
};

export const DEFAULT_USD_UZS_RATE = 12_700;

function readJson(name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(process.env[name] ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isPlanSlug(value: unknown): value is PlanSlug {
  return typeof value === "string" && (PLAN_SLUGS as readonly string[]).includes(value);
}

/** The plan with env overrides, e.g. PLAN_LIMITS_JSON='{"start":{"aiReplies":100}}'. */
export function getPlan(slug: string | null | undefined): Plan {
  const base = DEFAULTS[isPlanSlug(slug) ? slug : "start"];
  const patch = readJson("PLAN_LIMITS_JSON")[base.slug];
  if (!patch || typeof patch !== "object") return base;
  const limits = { ...base.limits } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key in limits && typeof value === typeof limits[key]) limits[key] = value;
  }
  return { ...base, limits: limits as unknown as PlanLimits };
}

export function allPlans(): Plan[] {
  return PLAN_SLUGS.map(getPlan);
}

/** Monthly price in so'm (whole so'm, rounded to 1 000); PLAN_PRICES_UZS_JSON overrides. */
export function priceUzs(slug: PlanSlug): number {
  const override = readJson("PLAN_PRICES_UZS_JSON")[slug];
  if (typeof override === "number" && override >= 0) return Math.round(override);
  const rate = Number(process.env.USD_UZS_RATE) || DEFAULT_USD_UZS_RATE;
  return Math.round((getPlan(slug).priceUsd * rate) / 1000) * 1000;
}

/** A paid plan holds until planExpiresAt; after that the workspace is on Start. */
export function effectivePlan(workspace: { planSlug?: string | null; planExpiresAt?: Date | null }, now = new Date()): Plan {
  const slug = workspace.planSlug ?? "start";
  if (slug !== "start" && workspace.planExpiresAt && workspace.planExpiresAt <= now) return getPlan("start");
  return getPlan(slug);
}

/**
 * BILLING_ENFORCED=1 turns limits on. Off (the default) every limit is only
 * reported, so existing workspaces keep working until the owner switches
 * paid plans on.
 */
export function billingEnforced(): boolean {
  return process.env.BILLING_ENFORCED === "1";
}
