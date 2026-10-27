/**
 * Content intelligence, step 3b (audit "Reja va senariy"): a two-week plan
 * built on the account's own evidence (which tags beat the median, which
 * posts brought leads, when the audience is online), a Reel scenario per
 * item on demand, and "make it a draft" into the Content Scheduler with the
 * CTA keyword's comment → DM campaign parked on the post.
 *
 * Every item says why, and cites the posts it is based on; an item whose
 * evidence is not one of the account's posts loses the citation rather than
 * inventing one.
 */

import { prisma } from "@/lib/db/client";
import { getLlmProvider, type LLMProvider } from "@/lib/assistant/llm/provider";
import { createPost } from "@/lib/content/service";
import { DEFAULT_TIMEZONE, utcToZoned, zonedToUtc } from "@/lib/content/time";
import { tagCorrelations } from "./report";

const DAY_MS = 86_400_000;
export const PLAN_DAYS = 14;
const FORMATS = ["reel", "carousel", "image", "story"] as const;
type PlanFormat = (typeof FORMATS)[number];

export interface ReelScenario {
  hooks: string[];
  script: Array<{ sec: string; text: string }>;
  shotList: Array<{ shot: string; camera: string }>;
  audio: { tempo: string; voice: string; music: string };
  subtitles: { style: string; keywords: string[] };
  caption: string;
  ctaKeyword: string;
  dmMessage: string;
  upload: { aspect: string; resolution: string; cover: string; firstComment: string; publishAt: string };
}

export interface PlanItem {
  key: string;
  date: string;
  time: string;
  format: PlanFormat;
  topic: string;
  hookIdeas: string[];
  why: string;
  evidence: string[];
  scenario?: ReelScenario | null;
  draftPostId?: string | null;
}

export class PlanError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          time: { type: "string" },
          format: { type: "string", enum: [...FORMATS] },
          topic: { type: "string" },
          hookIdeas: { type: "array", items: { type: "string" } },
          why: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["date", "time", "format", "topic", "hookIdeas", "why", "evidence"],
      },
    },
  },
  required: ["items"],
};

const SCENARIO_SCHEMA = {
  type: "object",
  properties: {
    hooks: { type: "array", items: { type: "string" } },
    script: { type: "array", items: { type: "object", properties: { sec: { type: "string" }, text: { type: "string" } }, required: ["sec", "text"] } },
    shotList: { type: "array", items: { type: "object", properties: { shot: { type: "string" }, camera: { type: "string" } }, required: ["shot", "camera"] } },
    audio: { type: "object", properties: { tempo: { type: "string" }, voice: { type: "string" }, music: { type: "string" } }, required: ["tempo", "voice", "music"] },
    subtitles: { type: "object", properties: { style: { type: "string" }, keywords: { type: "array", items: { type: "string" } } }, required: ["style", "keywords"] },
    caption: { type: "string" },
    ctaKeyword: { type: "string" },
    dmMessage: { type: "string" },
    upload: {
      type: "object",
      properties: { cover: { type: "string" }, firstComment: { type: "string" } },
      required: ["cover", "firstComment"],
    },
  },
  required: ["hooks", "script", "shotList", "audio", "subtitles", "caption", "ctaKeyword", "dmMessage", "upload"],
};

async function zoneOf(workspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  return ws?.timezone || DEFAULT_TIMEZONE;
}

async function ownedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { id: true, username: true } });
  if (!account) throw new PlanError(404, "Akkaunt topilmadi");
  return account;
}

/** The facts the model plans from: no Meta call, everything is stored already. */
async function evidence(workspaceId: string, accountId: string, now: Date) {
  const stats = await prisma.contentPostStat.findMany({
    where: { workspaceId, instagramAccountId: accountId, publishedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
    orderBy: { publishedAt: "desc" },
    take: 60,
  });
  const analyses = stats.length
    ? await prisma.contentAnalysis.findMany({ where: { statId: { in: stats.map((s) => s.id) }, status: "DONE" }, select: { statId: true, tags: true } })
    : [];
  const posts = stats
    .map((s) => {
      const tags = (analyses.find((a) => a.statId === s.id)?.tags ?? {}) as Record<string, unknown>;
      return {
        id: s.id,
        type: s.productType ?? s.mediaType,
        caption: (s.caption ?? "").slice(0, 160),
        score: s.score,
        leads: s.bizLeads,
        sales: s.bizSales,
        hook: tags.hookType ?? null,
        format: tags.format ?? null,
        topic: tags.topic ?? null,
        note: tags.note ?? null,
        weekdayHour: s.publishedAt.toISOString(),
      };
    })
    .sort((a, b) => (b.score ?? 0) + b.leads - ((a.score ?? 0) + a.leads))
    .slice(0, 20);
  const correlations = await tagCorrelations(accountId, now);
  let bestTimes: Array<{ weekday: number; hour: number }> = [];
  try {
    const { bestTimes: load } = await import("@/lib/content/insights");
    bestTimes = (await load(workspaceId, accountId, { now })).top.map((c) => ({ weekday: c.weekday, hour: c.hour }));
  } catch {
    bestTimes = [];
  }
  const profile = await prisma.assistantProfile
    .findFirst({ where: { workspaceId, OR: [{ instagramAccountId: accountId }, { instagramAccountId: null }] }, select: { companyName: true, description: true } })
    .catch(() => null);
  return { posts, correlations, bestTimes, profile: profile ? { company: profile.companyName, about: profile.description.slice(0, 600) } : null, statIds: new Set(stats.map((s) => s.id)) };
}

function cleanTime(value: unknown): string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "19:00";
}

export async function generatePlan(workspaceId: string, accountId: string, userId: string | null, opts: { now?: Date; provider?: LLMProvider | null } = {}) {
  const now = opts.now ?? new Date();
  const account = await ownedAccount(workspaceId, accountId);
  const provider = opts.provider === undefined ? getLlmProvider() : opts.provider;
  if (!provider) throw new PlanError(503, "LLM sozlanmagan");
  const tz = await zoneOf(workspaceId);
  const today = utcToZoned(now, tz).date;
  const startsOn = new Date(`${today}T00:00:00Z`);
  const last = new Date(startsOn.getTime() + (PLAN_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const facts = await evidence(workspaceId, accountId, now);

  const response = await provider.complete({
    system: `Siz Instagram kontent strategisiz. @${account.username} uchun ${today} dan ${last} gacha (14 kun) kontent reja tuzing.
Qoidalar:
- Faqat berilgan dalillarga tayaning: akkauntning o'z postlari (score = medianaga nisbat, lid va sotuv), teglar korrelyatsiyasi, auditoriya faol soatlari.
- Har bir band: date (YYYY-MM-DD, oraliq ichida), time (HH:MM, faol soatlarga yaqin), format (reel | carousel | image | story), topic, hookIdeas (2–3 ta), why (nima uchun — dalil bilan), evidence (dalil bo'lgan post id'lari, faqat berilganlardan).
- Haftasiga 3–5 ta post, Reels ustun, sotuv olib kelgan mavzular ko'proq.
- O'zbek tilida yozing.`,
    messages: [{ role: "user", content: JSON.stringify({ posts: facts.posts, correlations: facts.correlations, bestTimes: facts.bestTimes, timezone: tz, business: facts.profile }).slice(0, 24_000) }],
    schema: PLAN_SCHEMA,
    schemaName: "content_plan",
    temperature: 0.4,
    maxTokens: 3000,
    timeoutMs: 90_000,
    usage: { workspaceId, kind: "content_plan" },
  });
  const raw = ((response.json as { items?: unknown[] } | null)?.items ?? []) as Array<Record<string, unknown>>;
  const items: PlanItem[] = raw
    .map((r, i) => ({
      key: `i${i + 1}`,
      date: typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "",
      time: cleanTime(r.time),
      format: (FORMATS as readonly string[]).includes(String(r.format)) ? (r.format as PlanFormat) : "reel",
      topic: String(r.topic ?? "").slice(0, 120),
      hookIdeas: (Array.isArray(r.hookIdeas) ? r.hookIdeas : []).map(String).slice(0, 3),
      why: String(r.why ?? "").slice(0, 400),
      evidence: (Array.isArray(r.evidence) ? r.evidence : []).map(String).filter((id) => facts.statIds.has(id)).slice(0, 5),
      scenario: null,
      draftPostId: null,
    }))
    .filter((item) => item.date >= today && item.date <= last && item.topic)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (items.length === 0) throw new PlanError(502, "Model reja qaytarmadi — qayta urinib ko'ring");

  return prisma.contentPlan.create({
    data: { workspaceId, instagramAccountId: accountId, startsOn, items: JSON.parse(JSON.stringify(items)), model: response.model, createdById: userId },
  });
}

async function loadPlan(workspaceId: string, planId: string) {
  const plan = await prisma.contentPlan.findFirst({ where: { id: planId, workspaceId } });
  if (!plan) throw new PlanError(404, "Reja topilmadi");
  return { plan, items: (plan.items ?? []) as unknown as PlanItem[] };
}

function itemOf(items: PlanItem[], key: string): PlanItem {
  const item = items.find((i) => i.key === key);
  if (!item) throw new PlanError(404, "Reja bandi topilmadi");
  return item;
}

export async function generateScenario(workspaceId: string, planId: string, key: string, opts: { provider?: LLMProvider | null } = {}) {
  const { plan, items } = await loadPlan(workspaceId, planId);
  const item = itemOf(items, key);
  const provider = opts.provider === undefined ? getLlmProvider() : opts.provider;
  if (!provider) throw new PlanError(503, "LLM sozlanmagan");
  const evidencePosts = item.evidence.length
    ? await prisma.contentPostStat.findMany({ where: { id: { in: item.evidence }, workspaceId }, select: { caption: true, score: true, bizLeads: true } })
    : [];
  const response = await provider.complete({
    system: `Siz Reels senaristisiz. Berilgan reja bandi uchun to'liq senariy yozing (o'zbek tilida):
- hooks: 0–3 soniya uchun 2–3 variant (A/B test uchun, har biri boshqa turdagi: savol / natija / muammo / shok)
- script: kadr bo'yicha matn, sec ("0-3", "3-8"…) bilan, jami 15–45 s
- shotList: plan (yaqin, o'rta, b-roll) va kamera harakati
- audio: tempo, ovoz ohangi, musiqa uslubi
- subtitles: uslub va ajratiladigan kalit so'zlar
- caption: post matni, oxirida CTA ("NARX deb yozing" kabi)
- ctaKeyword: comment kalit so'zi (bitta so'z, katta harf)
- dmMessage: shu kalit so'zni yozganga DM'da yuboriladigan javob
- upload.cover: muqova g'oyasi; upload.firstComment: birinchi komment`,
    messages: [{ role: "user", content: JSON.stringify({ item, evidence: evidencePosts }) }],
    schema: SCENARIO_SCHEMA,
    schemaName: "reel_scenario",
    temperature: 0.6,
    maxTokens: 2500,
    timeoutMs: 90_000,
    usage: { workspaceId, kind: "content_plan" },
  });
  const raw = (response.json ?? {}) as Partial<ReelScenario> & { upload?: Partial<ReelScenario["upload"]> };
  const scenario: ReelScenario = {
    hooks: (raw.hooks ?? []).map(String).slice(0, 3),
    script: (raw.script ?? []).slice(0, 20),
    shotList: (raw.shotList ?? []).slice(0, 20),
    audio: { tempo: raw.audio?.tempo ?? "", voice: raw.audio?.voice ?? "", music: raw.audio?.music ?? "" },
    subtitles: { style: raw.subtitles?.style ?? "", keywords: (raw.subtitles?.keywords ?? []).map(String).slice(0, 10) },
    caption: String(raw.caption ?? "").slice(0, 2200),
    ctaKeyword: String(raw.ctaKeyword ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 30),
    dmMessage: String(raw.dmMessage ?? "").slice(0, 1000),
    // Fixed by the audit: vertical 1080×1920 at the planned slot.
    upload: { aspect: "9:16", resolution: "1080×1920", cover: raw.upload?.cover ?? "", firstComment: raw.upload?.firstComment ?? "", publishAt: `${item.date} ${item.time}` },
  };
  item.scenario = scenario;
  await prisma.contentPlan.update({ where: { id: plan.id }, data: { items: JSON.parse(JSON.stringify(items)) } });
  return scenario;
}

const POST_TYPE: Record<PlanFormat, "REEL" | "CAROUSEL" | "FEED_IMAGE" | "STORY"> = { reel: "REEL", carousel: "CAROUSEL", image: "FEED_IMAGE", story: "STORY" };

/** The item as a Content Scheduler draft (media is added by the owner), CTA campaign parked on it. */
export async function itemToDraft(workspaceId: string, planId: string, key: string, userId: string | null) {
  const { plan, items } = await loadPlan(workspaceId, planId);
  const item = itemOf(items, key);
  if (item.draftPostId) {
    const existing = await prisma.scheduledPost.findFirst({ where: { id: item.draftPostId, workspaceId, deletedAt: null }, select: { id: true } });
    if (existing) return { postId: existing.id, created: false };
  }
  const scenario = item.scenario ?? null;
  const caption = scenario?.caption || `${item.topic}\n\n${item.hookIdeas[0] ?? ""}`.trim();
  const keyword = scenario?.ctaKeyword || "";
  const post = await createPost(workspaceId, userId, {
    instagramAccountId: plan.instagramAccountId,
    type: POST_TYPE[item.format],
    caption: item.format === "story" ? undefined : caption,
    firstComment: scenario?.upload.firstComment || undefined,
    isAiGenerated: true,
    media: [],
    labels: ["ai-reja"],
    linkCampaign: keyword && scenario?.dmMessage && item.format !== "story" ? { create: { keywords: [keyword], dmMessage: scenario.dmMessage } } : undefined,
  });
  item.draftPostId = post.id;
  await prisma.contentPlan.update({ where: { id: plan.id }, data: { items: JSON.parse(JSON.stringify(items)), status: "ACTIVE" } });
  return { postId: post.id, created: true, slot: zonedToUtc(item.date, item.time, await zoneOf(workspaceId)).toISOString() };
}

export async function listPlans(workspaceId: string, accountId?: string) {
  return prisma.contentPlan.findMany({
    where: { workspaceId, ...(accountId ? { instagramAccountId: accountId } : {}), status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}
