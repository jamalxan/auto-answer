import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import type { Locale } from "@/lib/i18n/config";

export interface PricingPlanLocaleContent {
  name: string;
  description: string;
  features: string[];
}

export type PricingPlanContent = Record<Locale, PricingPlanLocaleContent>;

export interface PricingPlan {
  id: string;
  slug: string;
  priceAmount: number;
  priceCurrency: string;
  priceSuffix: string;
  content: PricingPlanContent;
  isFeatured: boolean;
  isActive: boolean;
  sortOrder: number;
}

const FALLBACK_LOCALE_CONTENT: PricingPlanLocaleContent = {
  name: "",
  description: "",
  features: [],
};

// Default marketing copy for a brand-new install — placeholder pricing, not
// a real billing tier (see lib/billing/usage.ts). The platform admin edits
// or replaces these from /admin once real numbers are decided.
const DEFAULT_PLANS: Array<Omit<PricingPlan, "id">> = [
  {
    slug: "starter",
    priceAmount: 0,
    priceCurrency: "$",
    priceSuffix: "/mo",
    isFeatured: false,
    isActive: true,
    sortOrder: 0,
    content: {
      en: {
        name: "Starter",
        description: "For one creator running their first comment-to-DM campaign.",
        features: [
          "1 Instagram account",
          "Unlimited campaigns",
          "Webhook + polling delivery",
          "DM logs with full status",
        ],
      },
      ru: {
        name: "Starter",
        description: "Для одного автора, запускающего первую кампанию «комментарий → DM».",
        features: [
          "1 аккаунт Instagram",
          "Неограниченные кампании",
          "Доставка через webhook и опрос",
          "Журналы DM с полным статусом",
        ],
      },
      uz: {
        name: "Starter",
        description: "Birinchi kommentariya→DM kampaniyasini boshlayotgan bitta ijodkor uchun.",
        features: [
          "1 ta Instagram akkaunt",
          "Cheklanmagan kampaniyalar",
          "Webhook + polling orqali yetkazish",
          "To'liq holatli DM jurnallari",
        ],
      },
    },
  },
  {
    slug: "pro",
    priceAmount: 19,
    priceCurrency: "$",
    priceSuffix: "/mo",
    isFeatured: true,
    isActive: true,
    sortOrder: 1,
    content: {
      en: {
        name: "Pro",
        description: "For a growing account juggling several live campaigns at once.",
        features: [
          "Up to 3 Instagram accounts",
          "Everything in Starter",
          "Tracked links with click stats",
          "Team roles: owner, admin, member",
        ],
      },
      ru: {
        name: "Pro",
        description: "Для растущего аккаунта, ведущего сразу несколько кампаний.",
        features: [
          "До 3 аккаунтов Instagram",
          "Всё из Starter",
          "Отслеживаемые ссылки со статистикой кликов",
          "Роли команды: владелец, администратор, участник",
        ],
      },
      uz: {
        name: "Pro",
        description: "Bir vaqtning o'zida bir nechta kampaniya olib boradigan o'sayotgan akkaunt uchun.",
        features: [
          "3 tagacha Instagram akkaunt",
          "Starter'dagi hamma narsa",
          "Klik statistikasi bilan kuzatiluvchi havolalar",
          "Jamoa rollari: owner, admin, member",
        ],
      },
    },
  },
  {
    slug: "agency",
    priceAmount: 49,
    priceCurrency: "$",
    priceSuffix: "/mo",
    isFeatured: false,
    isActive: true,
    sortOrder: 2,
    content: {
      en: {
        name: "Agency",
        description: "For agencies running comment-to-DM campaigns across client accounts.",
        features: [
          "Up to 10 Instagram accounts",
          "Everything in Pro",
          "Per-account filters for campaigns, logs, and stats",
          "Client-shareable, read-only reports",
        ],
      },
      ru: {
        name: "Agency",
        description: "Для агентств, ведущих кампании «комментарий → DM» на аккаунтах клиентов.",
        features: [
          "До 10 аккаунтов Instagram",
          "Всё из Pro",
          "Фильтры по аккаунту для кампаний, журналов и статистики",
          "Отчёты только для чтения, которыми можно поделиться с клиентом",
        ],
      },
      uz: {
        name: "Agency",
        description: "Mijoz akkauntlarida kommentariya→DM kampaniyalarini yurituvchi agentliklar uchun.",
        features: [
          "10 tagacha Instagram akkaunt",
          "Pro'dagi hamma narsa",
          "Kampaniyalar, jurnallar va statistika uchun har akkaunt bo'yicha filtrlar",
          "Mijozga ulashsa bo'ladigan, faqat o'qish uchun hisobotlar",
        ],
      },
    },
  },
];

/** Lazily seeds the default plans on first read, mirroring ensureWorkspaceForUser's pattern. */
async function ensureDefaultPricingPlans(): Promise<void> {
  const count = await prisma.pricingPlan.count();
  if (count > 0) return;

  await prisma.pricingPlan.createMany({
    data: DEFAULT_PLANS.map((plan) => ({
      slug: plan.slug,
      priceAmount: plan.priceAmount,
      priceCurrency: plan.priceCurrency,
      priceSuffix: plan.priceSuffix,
      content: plan.content as unknown as Prisma.InputJsonValue,
      isFeatured: plan.isFeatured,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
    })),
    skipDuplicates: true,
  });
}

function normalizeContent(raw: unknown): PricingPlanContent {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = (locale: Locale): PricingPlanLocaleContent => {
    const entry = record[locale];
    if (!entry || typeof entry !== "object") return FALLBACK_LOCALE_CONTENT;
    const e = entry as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "",
      description: typeof e.description === "string" ? e.description : "",
      features: Array.isArray(e.features)
        ? e.features.filter((f): f is string => typeof f === "string")
        : [],
    };
  };
  return { en: pick("en"), ru: pick("ru"), uz: pick("uz") };
}

// Simple in-process TTL cache, not Next's `unstable_cache`/`"use cache"`:
// this app now runs as one long-lived Node process per container (see
// docker-compose.prod.yml) rather than ephemeral serverless functions, so a
// module-level cache lives exactly as long as it should. It only covers a
// single `web` replica — if this ever scales to more than one, switch to a
// Redis-backed cache (a connection already exists in lib/queue/client.ts).
let activePlansCache: { data: PricingPlan[]; expiresAt: number } | null = null;
const ACTIVE_PLANS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Called by savePricingPlan/deletePricingPlan so an edit is visible on the
 * very next request instead of waiting out the TTL. */
export function invalidateActivePricingPlansCache(): void {
  activePlansCache = null;
}

/**
 * Public, active plans in display order — for the landing page. The
 * homepage already renders per-request (it reads the locale cookie), so
 * this is the layer that actually saves work: cached for 5 minutes rather
 * than re-querying Postgres on every visit.
 */
export async function getActivePricingPlans(): Promise<PricingPlan[]> {
  if (activePlansCache && activePlansCache.expiresAt > Date.now()) {
    return activePlansCache.data;
  }

  await ensureDefaultPricingPlans();

  const plans = await prisma.pricingPlan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  const data = plans.map((p) => ({
    id: p.id,
    slug: p.slug,
    priceAmount: p.priceAmount,
    priceCurrency: p.priceCurrency,
    priceSuffix: p.priceSuffix,
    content: normalizeContent(p.content),
    isFeatured: p.isFeatured,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  }));

  activePlansCache = { data, expiresAt: Date.now() + ACTIVE_PLANS_CACHE_TTL_MS };
  return data;
}

/** Every plan (including hidden ones) in display order — for /admin. */
export async function getAllPricingPlans(): Promise<PricingPlan[]> {
  await ensureDefaultPricingPlans();

  const plans = await prisma.pricingPlan.findMany({
    orderBy: { sortOrder: "asc" },
  });

  return plans.map((p) => ({
    id: p.id,
    slug: p.slug,
    priceAmount: p.priceAmount,
    priceCurrency: p.priceCurrency,
    priceSuffix: p.priceSuffix,
    content: normalizeContent(p.content),
    isFeatured: p.isFeatured,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  }));
}
