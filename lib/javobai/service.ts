/**
 * JavobAI (ETAP 4) — data access for the dev UI / API: per-account mode and
 * config, knowledge entries on top of the production knowledge base, scoring
 * config, handoff rules, conversations with their JavobAI state, shadow
 * turns, leads with insight, LLM usage / budget and the sandbox.
 *
 * Every query is scoped to one workspace; an Instagram account, conversation,
 * entry or rule of another workspace reads as "not found". Nothing here sends
 * a message — the engine (gate, turn, handoff, worker) lives next door and is
 * only called through its public functions.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { AiHandoffState, AiTemperature, JavobAiMode, Prisma } from "@/app/generated/prisma/client";
import { findProfile, isProfileLive } from "@/lib/assistant/profile";
import {
  DEFAULT_JAVOBAI_CONFIG,
  DEFAULT_SCORING,
  HANDOFF_REASONS,
  INTENTS,
  isJavobAiEnabled,
  QUALIFICATION_FIELDS,
  readJavobAiConfig,
  SCORE_SIGNALS,
  type JavobAiConfig,
} from "./config";
import { budgetPct, budgetStatusFor, BudgetValidationError, getBudget, saveBudget } from "./budget";
import { forgetJavobAiGate } from "./gate";
import { acceptHandoff, closeHandoff, reopenAi } from "./handoff";
import { previewKnowledge } from "./knowledge";
import { runJavobAiSandbox } from "./sandbox";
import { isJavobAiKind, monthlyUsage } from "./usage";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const done = <T>(data: T) => ({ ok: true as const, data });

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

export const ACCOUNT_NOT_FOUND = "Instagram akkaunt topilmadi — u boshqa workspace'ga tegishli yoki uzilgan";
export const CONVERSATION_NOT_FOUND = "Suhbat topilmadi";
export const ENTRY_NOT_FOUND = "Bilim yozuvi topilmadi";
export const RULE_NOT_FOUND = "Qoida topilmadi";
export const NO_PROFILE =
  "Bilim bazasi yo'q: bu akkaunt uchun AI assistent profili yaratilmagan. Avval /assistant sahifasida profilni to'ldiring — JavobAI o'sha profil, mahsulotlar va FAQ'dan foydalanadi.";
export const LIVE_NEEDS_PROFILE =
  "LIVE rejim uchun yoqilgan va tasdiqlangan AI assistent profili kerak. /assistant sahifasida profilni to'ldirib, \"Tasdiqlash\" ni bosing, keyin qayta urinib ko'ring.";
export const NO_AI_STATE = "Bu suhbatda JavobAI hali ishlamagan — holati yo'q";

export const JAVOBAI_MODES = ["OFF", "SHADOW", "LIVE"] as const;
export const AI_KNOWLEDGE_KINDS = ["DISCOUNT", "CONTACT", "TERMS", "BRANCH", "POLICY", "OTHER", "PRICE", "HOURS", "DELIVERY"] as const;
export const HANDOFF_RULE_KINDS = ["KEYWORD", "INTENT", "SCORE", "UNKNOWN_COUNT", "OFF_HOURS"] as const;
export const HANDOFF_STATES = ["AI_ACTIVE", "HANDOFF_PENDING", "OPERATOR_ACTIVE", "CLOSED"] as const;
export const TEMPERATURES = ["COLD", "WARM", "HOT", "CUSTOMER", "LOST"] as const;

export const KNOWLEDGE_LIMITS = { title: 120, body: 2000, keywordsPerRule: 20, keywordLength: 60 } as const;

/** Kill switch (`JAVOBAI_DISABLED`): every account answers through production regardless of mode. */
export function isJavobAiDisabled(): boolean {
  return !isJavobAiEnabled();
}

function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const modeInputSchema = z.object({ mode: z.enum(JAVOBAI_MODES) });

async function accountInWorkspace(workspaceId: string, instagramAccountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
    select: { id: true, username: true, tokenStatus: true },
  });
}

async function profileStatus(workspaceId: string, instagramAccountId: string) {
  const profile = await findProfile(workspaceId, instagramAccountId);
  if (!profile) return { exists: false as const, live: false, approved: false, enabled: false, scope: null, id: null, companyName: null };
  return {
    exists: true as const,
    live: isProfileLive(profile),
    // The assistant page's own two flags (B-41): approved (Tasdiqlangan) and enabled (yoqilgan).
    approved: profile.approvedAt !== null,
    enabled: profile.enabled,
    scope: profile.instagramAccountId ? ("account" as const) : ("workspace" as const),
    id: profile.id,
    companyName: profile.companyName,
    products: profile.products.length,
    faqs: profile.faqs.length,
  };
}

export async function listJavobAiAccounts(workspaceId: string) {
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      tokenStatus: true,
      javobAiAccount: { select: { mode: true, config: true, enabledBy: true, updatedAt: true } },
    },
  });
  const rows = await Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      username: account.username,
      tokenStatus: account.tokenStatus,
      mode: (account.javobAiAccount?.mode ?? "OFF") as JavobAiMode,
      config: readJavobAiConfig(account.javobAiAccount?.config),
      enabledBy: account.javobAiAccount?.enabledBy ?? null,
      updatedAt: account.javobAiAccount?.updatedAt ?? null,
      profile: await profileStatus(workspaceId, account.id),
    }))
  );
  return {
    accounts: rows,
    disabled: isJavobAiDisabled(),
    defaults: DEFAULT_JAVOBAI_CONFIG,
    qualificationFields: QUALIFICATION_FIELDS,
    signals: SCORE_SIGNALS,
  };
}

export async function setJavobAiMode(
  workspaceId: string,
  instagramAccountId: string,
  mode: JavobAiMode,
  by: string
): Promise<ServiceResult<{ id: string; mode: JavobAiMode }>> {
  const account = await accountInWorkspace(workspaceId, instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  if (mode === "LIVE") {
    const profile = await findProfile(workspaceId, instagramAccountId);
    if (!profile || !isProfileLive(profile)) return fail(422, LIVE_NEEDS_PROFILE);
  }
  await prisma.javobAiAccount.upsert({
    where: { instagramAccountId },
    create: { workspaceId, instagramAccountId, mode, enabledBy: by, config: {} },
    update: { mode, enabledBy: by },
  });
  await forgetJavobAiGate(instagramAccountId);
  return done({ id: instagramAccountId, mode });
}

export async function saveJavobAiConfig(
  workspaceId: string,
  instagramAccountId: string,
  config: JavobAiConfig
): Promise<ServiceResult<{ id: string; config: JavobAiConfig }>> {
  const account = await accountInWorkspace(workspaceId, instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  const json = config as unknown as Prisma.InputJsonObject;
  await prisma.javobAiAccount.upsert({
    where: { instagramAccountId },
    create: { workspaceId, instagramAccountId, mode: "OFF", config: json },
    update: { config: json },
  });
  await forgetJavobAiGate(instagramAccountId);
  return done({ id: instagramAccountId, config });
}

// ─── Knowledge entries ────────────────────────────────────────────────────────

export const knowledgeEntrySchema = z.object({
  kind: z.enum(AI_KNOWLEDGE_KINDS),
  title: z
    .string()
    .trim()
    .min(1, "Sarlavhani kiriting")
    .max(KNOWLEDGE_LIMITS.title, `Sarlavha ${KNOWLEDGE_LIMITS.title} belgidan oshmasin`),
  body: z
    .string()
    .trim()
    .min(1, "Matnni kiriting")
    .max(KNOWLEDGE_LIMITS.body, `Matn ${KNOWLEDGE_LIMITS.body} belgidan oshmasin`),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(10_000).default(0),
});

export const knowledgeEntryPatchSchema = knowledgeEntrySchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  "O'zgartiriladigan maydon yo'q"
);

export const verifyInputSchema = z.object({ verified: z.boolean() });

export type KnowledgeEntryInput = z.infer<typeof knowledgeEntrySchema>;

/** Ids of every profile of the workspace: entries hang off a profile, not a workspace. */
async function workspaceProfileIds(workspaceId: string): Promise<string[]> {
  const profiles = await prisma.assistantProfile.findMany({ where: { workspaceId }, select: { id: true } });
  return profiles.map((p) => p.id);
}

async function entryInWorkspace(workspaceId: string, entryId: string) {
  const profileIds = await workspaceProfileIds(workspaceId);
  if (profileIds.length === 0) return null;
  return prisma.aiKnowledgeEntry.findFirst({ where: { id: entryId, profileId: { in: profileIds } } });
}

export async function listKnowledge(workspaceId: string, instagramAccountId: string) {
  const account = await accountInWorkspace(workspaceId, instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  const profile = await profileStatus(workspaceId, instagramAccountId);
  if (!profile.exists) {
    return done({ profile, entries: [], preview: { lines: [], chars: 0, truncated: false } });
  }
  const [entries, preview] = await Promise.all([
    prisma.aiKnowledgeEntry.findMany({
      where: { profileId: profile.id },
      orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
    }),
    previewKnowledge(workspaceId, instagramAccountId),
  ]);
  return done({ profile, entries, preview });
}

export async function createKnowledgeEntry(workspaceId: string, instagramAccountId: string, input: KnowledgeEntryInput) {
  const account = await accountInWorkspace(workspaceId, instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  const profile = await findProfile(workspaceId, instagramAccountId);
  if (!profile) return fail(422, NO_PROFILE);
  const entry = await prisma.aiKnowledgeEntry.create({ data: { ...input, profileId: profile.id } });
  return done(entry);
}

export async function updateKnowledgeEntry(
  workspaceId: string,
  entryId: string,
  patch: z.infer<typeof knowledgeEntryPatchSchema>
) {
  const existing = await entryInWorkspace(workspaceId, entryId);
  if (!existing) return fail(404, ENTRY_NOT_FOUND);
  // Changing the text invalidates the check someone made on the old text.
  const textChanged =
    (patch.body !== undefined && patch.body !== existing.body) ||
    (patch.title !== undefined && patch.title !== existing.title);
  const entry = await prisma.aiKnowledgeEntry.update({
    where: { id: entryId },
    data: { ...patch, ...(textChanged ? { verifiedAt: null } : {}) },
  });
  return done(entry);
}

export async function deleteKnowledgeEntry(workspaceId: string, entryId: string) {
  const existing = await entryInWorkspace(workspaceId, entryId);
  if (!existing) return fail(404, ENTRY_NOT_FOUND);
  await prisma.aiKnowledgeEntry.delete({ where: { id: entryId } });
  return done({ id: entryId });
}

export async function setKnowledgeVerified(workspaceId: string, entryId: string, verified: boolean) {
  const existing = await entryInWorkspace(workspaceId, entryId);
  if (!existing) return fail(404, ENTRY_NOT_FOUND);
  const entry = await prisma.aiKnowledgeEntry.update({
    where: { id: entryId },
    data: { verifiedAt: verified ? new Date() : null },
  });
  return done(entry);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const SIGNAL_KEYS = new Set<string>(SCORE_SIGNALS.map((s) => s.key));

export const scoringConfigSchema = z
  .object({
    rules: z
      .array(
        z.object({
          signal: z.string().refine((key) => SIGNAL_KEYS.has(key), "Noma'lum signal"),
          points: z
            .number()
            .int("Ball butun son bo'lsin")
            .min(-100, "Ball −100…100 oralig'ida bo'lsin")
            .max(100, "Ball −100…100 oralig'ida bo'lsin"),
        })
      )
      .max(SCORE_SIGNALS.length * 2),
    thresholds: z.object({
      warm: z.number().int().min(1).max(100),
      hot: z.number().int().min(1).max(100),
      veryHot: z.number().int().min(1).max(100),
    }),
    handoffAtScore: z.number().int().min(1, "Ball 1…100").max(100, "Ball 1…100").nullish(),
    lostAfterDays: z.number().int().min(1, "Kunlar 1…365").max(365, "Kunlar 1…365").nullish(),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const rule of input.rules) {
      if (seen.has(rule.signal)) {
        ctx.addIssue({ code: "custom", path: ["rules"], message: `"${rule.signal}" signali ikki marta yozilgan` });
      }
      seen.add(rule.signal);
    }
    const { warm, hot, veryHot } = input.thresholds;
    if (!(warm < hot && hot < veryHot)) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholds"],
        message: "Chegaralar o'sib borsin: Warm < Hot < Very hot (masalan 30 < 60 < 80)",
      });
    }
  });

export type ScoringConfigInput = z.infer<typeof scoringConfigSchema>;

function defaultScoring(): ScoringConfigInput {
  return {
    rules: DEFAULT_SCORING.rules.map((r) => ({ signal: r.signal, points: r.points })),
    thresholds: { ...DEFAULT_SCORING.thresholds },
    handoffAtScore: null,
    lostAfterDays: null,
  };
}

export async function getScoringConfig(workspaceId: string) {
  const row = await prisma.aiScoringConfig.findFirst({ where: { workspaceId, instagramAccountId: null } });
  const parsed = row
    ? scoringConfigSchema.safeParse({
        rules: row.rules,
        thresholds: row.thresholds,
        handoffAtScore: row.handoffAtScore,
        lostAfterDays: row.lostAfterDays,
      })
    : null;
  const config = parsed?.success ? parsed.data : defaultScoring();
  return { config, isDefault: !parsed?.success, signals: SCORE_SIGNALS, updatedAt: row?.updatedAt ?? null };
}

export async function saveScoringConfig(workspaceId: string, input: ScoringConfigInput) {
  const data = {
    rules: input.rules as unknown as Prisma.InputJsonArray,
    thresholds: input.thresholds as unknown as Prisma.InputJsonObject,
    handoffAtScore: input.handoffAtScore ?? null,
    lostAfterDays: input.lostAfterDays ?? null,
  };
  const existing = await prisma.aiScoringConfig.findFirst({
    where: { workspaceId, instagramAccountId: null },
    select: { id: true },
  });
  const row = existing
    ? await prisma.aiScoringConfig.update({ where: { id: existing.id }, data })
    : await prisma.aiScoringConfig.create({ data: { ...data, workspaceId, instagramAccountId: null } });
  return done({ config: input, updatedAt: row.updatedAt });
}

/** Pure: score → temperature band, as the UI calculator and the tests use it. */
export function temperatureForScore(score: number, thresholds: ScoringConfigInput["thresholds"]): "COLD" | "WARM" | "HOT" {
  if (score >= thresholds.hot) return "HOT";
  if (score >= thresholds.warm) return "WARM";
  return "COLD";
}

// ─── Handoff rules ────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTENT_KEYS = new Set<string>(INTENTS);

export const handoffRuleSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("KEYWORD"),
      value: z.object({
        keywords: z
          .array(
            z
              .string()
              .trim()
              .min(1, "Bo'sh kalit so'z qoldirmang")
              .max(KNOWLEDGE_LIMITS.keywordLength, `Kalit so'z ${KNOWLEDGE_LIMITS.keywordLength} belgidan oshmasin`)
          )
          .min(1, "Kamida bitta kalit so'z kiriting")
          .max(KNOWLEDGE_LIMITS.keywordsPerRule, `Bitta qoidada ko'pi bilan ${KNOWLEDGE_LIMITS.keywordsPerRule} ta kalit so'z`),
      }),
    }),
    z.object({
      kind: z.literal("INTENT"),
      value: z.object({
        intents: z
          .array(z.string().refine((key) => INTENT_KEYS.has(key), "Noma'lum intent"))
          .min(1, "Kamida bitta intent tanlang")
          .max(INTENTS.length),
      }),
    }),
    z.object({
      kind: z.literal("SCORE"),
      value: z.object({ min: z.number().int().min(1, "Ball 1…100").max(100, "Ball 1…100") }),
    }),
    z.object({
      kind: z.literal("UNKNOWN_COUNT"),
      value: z.object({ count: z.number().int().min(1, "Soni 1…5").max(5, "Soni 1…5") }),
    }),
    z.object({
      kind: z.literal("OFF_HOURS"),
      value: z.object({
        from: z.string().regex(HHMM, "Vaqt HH:MM ko'rinishida bo'lsin, masalan 18:00"),
        to: z.string().regex(HHMM, "Vaqt HH:MM ko'rinishida bo'lsin, masalan 09:00"),
      }),
    }),
  ])
  .and(z.object({ active: z.boolean().default(true) }));

export type HandoffRuleInput = z.infer<typeof handoffRuleSchema>;

export const handoffRuleToggleSchema = z.object({ active: z.boolean() }).strict();

export async function listHandoffRules(workspaceId: string) {
  const rules = await prisma.aiHandoffRule.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  return { rules, intents: INTENTS, reasons: HANDOFF_REASONS };
}

export async function createHandoffRule(workspaceId: string, input: HandoffRuleInput) {
  const rule = await prisma.aiHandoffRule.create({
    data: { workspaceId, kind: input.kind, value: input.value as Prisma.InputJsonObject, active: input.active },
  });
  return done(rule);
}

export async function updateHandoffRule(
  workspaceId: string,
  ruleId: string,
  input: HandoffRuleInput | z.infer<typeof handoffRuleToggleSchema>
) {
  const existing = await prisma.aiHandoffRule.findFirst({ where: { id: ruleId, workspaceId }, select: { id: true } });
  if (!existing) return fail(404, RULE_NOT_FOUND);
  const data: Prisma.AiHandoffRuleUpdateInput =
    "kind" in input
      ? { kind: input.kind, value: input.value as Prisma.InputJsonObject, active: input.active }
      : { active: input.active };
  const rule = await prisma.aiHandoffRule.update({ where: { id: ruleId }, data });
  return done(rule);
}

export async function deleteHandoffRule(workspaceId: string, ruleId: string) {
  const existing = await prisma.aiHandoffRule.findFirst({ where: { id: ruleId, workspaceId }, select: { id: true } });
  if (!existing) return fail(404, RULE_NOT_FOUND);
  await prisma.aiHandoffRule.delete({ where: { id: ruleId } });
  return done({ id: ruleId });
}

// ─── Conversations ────────────────────────────────────────────────────────────

export const conversationsQuerySchema = z.object({
  instagramAccountId: z.string().min(1).max(64).optional(),
  handoffState: z.enum(HANDOFF_STATES).optional(),
  temperature: z.enum(TEMPERATURES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ConversationsQuery = z.infer<typeof conversationsQuerySchema>;

export async function listConversations(workspaceId: string, query: ConversationsQuery) {
  const states = await prisma.aiConversationState.findMany({
    where: {
      conversation: {
        workspaceId,
        ...(query.instagramAccountId ? { instagramAccountId: query.instagramAccountId } : {}),
      },
      ...(query.handoffState ? { handoffState: query.handoffState as AiHandoffState } : {}),
      ...(query.temperature ? { temperature: query.temperature as AiTemperature } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    include: {
      conversation: {
        select: {
          id: true,
          igUserId: true,
          igUsername: true,
          igName: true,
          instagramAccountId: true,
          botPaused: true,
          lastCustomerMessageAt: true,
          instagramAccount: { select: { username: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { author: true, text: true, createdAt: true } },
        },
      },
    },
  });
  return states.map((state) => ({
    id: state.conversation.id,
    igUserId: state.conversation.igUserId,
    igUsername: state.conversation.igUsername,
    igName: state.conversation.igName,
    instagramAccountId: state.conversation.instagramAccountId,
    accountUsername: state.conversation.instagramAccount.username,
    botPaused: state.conversation.botPaused,
    handoffState: state.handoffState,
    score: state.score,
    temperature: state.temperature,
    turns: state.turns,
    unknownStreak: state.unknownStreak,
    lastMessage: state.conversation.messages[0] ?? null,
    lastCustomerMessageAt: state.conversation.lastCustomerMessageAt,
    updatedAt: state.updatedAt,
  }));
}

export async function getConversation(workspaceId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      instagramAccount: { select: { username: true } },
      aiState: { include: { scoreEvents: { orderBy: { createdAt: "asc" } } } },
      aiHandoffs: { orderBy: { openedAt: "desc" }, take: 20 },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, author: true, text: true, createdAt: true, llmMeta: true },
      },
      leads: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          name: true,
          phoneE164: true,
          productInterest: true,
          summary: true,
          isTest: true,
          status: true,
          createdAt: true,
          aiInsight: true,
        },
      },
    },
  });
  if (!conversation) return null;
  const { messages, leads, aiState, aiHandoffs, ...rest } = conversation;
  return {
    ...rest,
    accountUsername: conversation.instagramAccount.username,
    messages: [...messages].reverse(),
    state: aiState,
    handoffs: aiHandoffs,
    lead: leads[0] ?? null,
  };
}

export const handoffActionSchema = z.object({
  action: z.enum(["accept", "close", "reopen"]),
  resumeAi: z.boolean().optional(),
});

export async function runHandoffAction(
  workspaceId: string,
  conversationId: string,
  input: z.infer<typeof handoffActionSchema>,
  by: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, aiState: { select: { id: true } } },
  });
  if (!conversation) return fail(404, CONVERSATION_NOT_FOUND);
  if (!conversation.aiState) return fail(422, NO_AI_STATE);
  if (input.action === "accept") await acceptHandoff(conversationId, by);
  else if (input.action === "close") await closeHandoff(conversationId, by, input.resumeAi ?? true);
  else await reopenAi(conversationId);
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId } });
  return done({ id: conversationId, handoffState: state?.handoffState ?? null });
}

export const temperatureInputSchema = z.object({ temperature: z.enum(["CUSTOMER", "LOST"]) });

/** CUSTOMER / LOST are operator decisions; COLD/WARM/HOT follow the score. */
export async function setConversationTemperature(
  workspaceId: string,
  conversationId: string,
  temperature: "CUSTOMER" | "LOST"
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, aiState: { select: { id: true } } },
  });
  if (!conversation) return fail(404, CONVERSATION_NOT_FOUND);
  if (!conversation.aiState) return fail(422, NO_AI_STATE);
  const state = await prisma.aiConversationState.update({ where: { conversationId }, data: { temperature } });
  return done({ id: conversationId, temperature: state.temperature });
}

// ─── Shadow turns ─────────────────────────────────────────────────────────────

export const shadowQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function listShadowTurns(workspaceId: string, query: z.infer<typeof shadowQuerySchema>) {
  const [rows, stats, handoffs, errors] = await Promise.all([
    prisma.aiShadowTurn.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    }),
    prisma.aiShadowTurn.aggregate({
      where: { workspaceId },
      _count: { _all: true },
      _avg: { confidence: true },
      _sum: { costUsd: true },
    }),
    prisma.aiShadowTurn.count({ where: { workspaceId, handoff: { not: null } } }),
    prisma.aiShadowTurn.count({ where: { workspaceId, error: { not: null } } }),
  ]);
  const page = rows.slice(0, query.limit);
  return {
    turns: page.map((t) => ({ ...t, costUsd: decimalToNumber(t.costUsd) })),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    stats: {
      count: stats._count._all,
      avgConfidence: stats._avg.confidence ?? null,
      handoffs,
      handoffRate: stats._count._all ? handoffs / stats._count._all : 0,
      errors,
      costUsd: decimalToNumber(stats._sum.costUsd),
    },
  };
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function listLeadsWithInsight(workspaceId: string, limit = 50) {
  const leads = await prisma.lead.findMany({
    where: { workspaceId, aiInsight: { isNot: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      conversationId: true,
      igUsername: true,
      igUserId: true,
      name: true,
      phoneE164: true,
      productInterest: true,
      status: true,
      isTest: true,
      flag: true,
      createdAt: true,
      instagramAccount: { select: { username: true } },
      aiInsight: true,
    },
  });
  return leads.map((lead) => ({ ...lead, accountUsername: lead.instagramAccount.username }));
}

// ─── Usage and budget ─────────────────────────────────────────────────────────

export { isJavobAiKind };

/** This Tashkent month's LLM usage by kind (JavobAI next to production) and the budget. */
export async function getUsage(workspaceId: string) {
  const [usage, budget] = await Promise.all([monthlyUsage(workspaceId), getBudget(workspaceId)]);
  return {
    since: usage.periodStart,
    until: usage.periodEnd,
    kinds: usage.byKind.map((k) => ({
      kind: k.kind,
      label: k.label,
      javobai: k.javobAi,
      calls: k.calls,
      failedCalls: k.failedCalls,
      inputTokens: k.inputTokens,
      outputTokens: k.outputTokens,
      costUsd: k.costUsd,
    })),
    calls: usage.calls,
    totalUsd: usage.totalUsd,
    javobaiUsd: usage.javobAiUsd,
    productionUsd: usage.productionUsd,
    budget: budget
      ? {
          monthlyUsdSoft: budget.monthlyUsdSoft,
          monthlyUsdHard: budget.monthlyUsdHard,
          alerted50At: budget.alerted50At,
          alerted80At: budget.alerted80At,
          alerted100At: budget.alerted100At,
          periodStart: budget.periodStart,
          status: budgetStatusFor(usage.totalUsd, budget.monthlyUsdSoft, budget.monthlyUsdHard),
          pct: budgetPct(usage.totalUsd, budget.monthlyUsdSoft),
        }
      : null,
  };
}

export const budgetSchema = z
  .object({
    monthlyUsdSoft: z.number().min(0.01, "Yumshoq limit 0 dan katta bo'lsin").max(1_000_000, "Limit juda katta"),
    monthlyUsdHard: z.number().min(0.01, "Qattiq limit 0 dan katta bo'lsin").max(1_000_000, "Limit juda katta").nullish(),
  })
  .refine(
    (b) => b.monthlyUsdHard === null || b.monthlyUsdHard === undefined || b.monthlyUsdHard >= b.monthlyUsdSoft,
    "Qattiq limit yumshoq limitdan kichik bo'lmasin"
  );

export async function saveWorkspaceBudget(workspaceId: string, input: z.infer<typeof budgetSchema>) {
  try {
    const budget = await saveBudget(workspaceId, {
      monthlyUsdSoft: input.monthlyUsdSoft,
      monthlyUsdHard: input.monthlyUsdHard ?? null,
    });
    return done({ monthlyUsdSoft: budget.monthlyUsdSoft, monthlyUsdHard: budget.monthlyUsdHard });
  } catch (error) {
    if (error instanceof BudgetValidationError) return fail(400, error.message);
    throw error;
  }
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

export const sandboxInputSchema = z.object({
  instagramAccountId: z.string().min(1, "Instagram akkauntni tanlang"),
  messages: z
    .array(
      z.object({
        role: z.enum(["customer", "assistant"]),
        text: z.string().trim().min(1, "Bo'sh xabar yuborib bo'lmaydi").max(2000, "Xabar 2000 belgidan oshmasin"),
      })
    )
    .min(1, "Kamida bitta xabar kerak")
    .max(40, "Sandbox ko'pi bilan 40 ta xabarni oladi"),
  // A returning contact: what JavobAI already knows (score / extracted fields).
  contactState: z
    .object({
      score: z.number().int().min(0).max(100).optional(),
      extracted: z.record(z.string(), z.string().max(200)).optional(),
    })
    .optional(),
});

export type SandboxInput = z.infer<typeof sandboxInputSchema>;

export async function runSandbox(workspaceId: string, input: SandboxInput) {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  const result = await runJavobAiSandbox(workspaceId, {
    instagramAccountId: input.instagramAccountId,
    messages: input.messages,
    contactState: input.contactState,
  });
  return done(result);
}
