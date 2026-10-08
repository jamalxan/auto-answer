import { prisma } from "@/lib/db/client";
import type { ProfileSnapshot } from "./prompt";
import { readLearnedExamples } from "./learning";

export interface WorkingHours {
  /** Free text shown to the model and to customers: "Du–Sha 9:00–18:00". */
  text?: string;
  /** Machine-readable schedule used by the optional off-hours filter. */
  enabled?: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days?: number[];
  from?: string; // "09:00"
  to?: string; // "18:00"
  /** Minutes east of UTC. Uzbekistan = 300. */
  tzOffsetMinutes?: number;
}

export function readWorkingHours(value: unknown): WorkingHours | null {
  return value && typeof value === "object" ? (value as WorkingHours) : null;
}

function toMinutes(hhmm: string | undefined, fallback: number): number {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

/** Is `now` inside the schedule? Without an enabled schedule it is always "open". */
export function isWithinWorkingHours(hours: WorkingHours | null, now = new Date()): boolean {
  if (!hours?.enabled) return true;
  const offset = hours.tzOffsetMinutes ?? 300;
  const local = new Date(now.getTime() + offset * 60_000);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = hours.days?.length ? hours.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(day)) return false;
  const from = toMinutes(hours.from, 9 * 60);
  const to = toMinutes(hours.to, 18 * 60);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export type LoadedProfile = NonNullable<Awaited<ReturnType<typeof findProfile>>>;

/** Account-specific profile first, then the workspace-wide one (instagramAccountId = null). */
export async function findProfile(workspaceId: string, instagramAccountId?: string | null) {
  const include = {
    products: { orderBy: { sort: "asc" as const } },
    faqs: { orderBy: { sort: "asc" as const } },
  };
  if (instagramAccountId) {
    const specific = await prisma.assistantProfile.findFirst({
      where: { workspaceId, instagramAccountId },
      include,
    });
    if (specific) return specific;
  }
  return prisma.assistantProfile.findFirst({
    where: { workspaceId, instagramAccountId: null },
    include,
  });
}

export function toSnapshot(profile: LoadedProfile): ProfileSnapshot {
  const hours = readWorkingHours(profile.workingHours);
  const categories = Array.isArray(profile.categories)
    ? (profile.categories as Array<{ name?: string; note?: string }>)
        .filter((c) => c && typeof c.name === "string")
        .map((c) => ({ name: c.name as string, note: c.note }))
    : [];
  return {
    companyName: profile.companyName,
    description: profile.description,
    pricePolicy: profile.pricePolicy,
    tone: profile.tone,
    personaName: profile.personaName,
    extraFieldLabel: profile.extraFieldLabel,
    address: profile.address,
    delivery: profile.delivery,
    workingHours: hours?.text ?? null,
    paymentMethods: profile.paymentMethods,
    categories,
    faqs: profile.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    products: profile.products.map((p) => ({
      name: p.name,
      note: p.note,
      price: p.price === null ? null : Number(p.price),
      priceIsFrom: p.priceIsFrom,
      currency: p.currency,
      unit: p.unit,
    })),
    finalMessageTemplate: profile.finalMessageTemplate,
    learned:
      profile.learningEnabled && profile.learnedStyle
        ? { style: profile.learnedStyle, examples: readLearnedExamples(profile.learnedExamples) }
        : null,
  };
}

export function isProfileLive(profile: { enabled: boolean; approvedAt: Date | null }): boolean {
  return profile.enabled && profile.approvedAt !== null;
}

// ─── Plan limits & feature flags (TZ section 13) ───────────────────────────────

export function defaultAiConversationLimit(): number {
  const fromEnv = Number(process.env.AI_CONVERSATIONS_PER_MONTH);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300;
}

export function aiConversationLimit(workspace: { aiConversationsLimit: number | null }): number {
  return workspace.aiConversationsLimit ?? defaultAiConversationLimit();
}

/** FEATURE_FLAGS='{"integrations":false}' disables a feature; default is on. */
export function isFeatureEnabled(flag: "integrations" | "assistant" | "telegram_onboarding"): boolean {
  try {
    const flags = JSON.parse(process.env.FEATURE_FLAGS ?? "{}") as Record<string, boolean>;
    return flags[flag] !== false;
  } catch {
    return true;
  }
}
