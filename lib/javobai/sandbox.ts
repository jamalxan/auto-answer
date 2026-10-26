/**
 * Sandbox: the exact same `runJavobAiTurn` as the Instagram flow, with the
 * conversation held in memory by the caller (the dev UI chat). Nothing is
 * sent, no lead is created, no state is stored — the only write is the
 * LlmUsage row (kind "javobai_sandbox") so the model spend stays visible.
 *
 * The caller passes the whole transcript; the last customer message(s) are
 * this turn, everything before is history. Counters that the engine keeps
 * on stored messages (phone asks, asked qualification fields, turns) are
 * derived from the transcript, so the sandbox follows the same flow. The
 * workspace budget (4.4) applies here too: the hard limit returns its reason
 * instead of a reply, the soft limit picks the cheap path.
 */

import { getLlmProviderFor } from "@/lib/assistant/llm/provider";
import { prisma } from "@/lib/db/client";
import { findProfile } from "@/lib/assistant/profile";
import { extractPhone } from "@/lib/leads/phone";
import type { Collected } from "@/lib/leads/service";
import { enforceBudgetBeforeCall } from "./budget";
import { type QualificationField } from "./config";
import { loadKnowledgeBlock } from "./knowledge";
import { modelForTask, perTurnCaps } from "./routing";
import { loadAccountConfig, loadHandoffRules, loadScoringConfig } from "./state";
import { runJavobAiTurn, type ExtractedFields } from "./turn";
import { recordJavobAiUsage } from "./usage";

export const USAGE_KIND_SANDBOX = "javobai_sandbox";

export interface SandboxInput {
  instagramAccountId: string;
  messages: { role: "customer" | "assistant"; text: string }[];
  contactState?: { score?: number; extracted?: Record<string, string> };
  /** The golden eval reuses the sandbox turn; its spend is its own usage kind. */
  usageKind?: "javobai_sandbox" | "javobai_eval";
}

export interface SandboxResult {
  reply: string;
  intent: string;
  confidence: number;
  usedFacts: string[];
  extracted: Record<string, string | null>;
  language: string;
  score: number;
  temperature: string;
  signals: { signal: string; points: number }[];
  handoff: { needed: boolean; reason?: string };
  unknownQuestion?: string | null;
  blockedBy?: string | null;
  costUsd: number;
  /** 4.4: "ok" | "soft_exceeded" | "hard_exceeded" of the workspace budget for this turn. */
  budgetStatus: string;
}

const PHONE_ASK = /(raqam|nomer|telefon|рақам|номер|телефон)/i;
const FIELD_ASK: Record<QualificationField, RegExp> = {
  product: /(qaysi mahsulot|qaysi xizmat|қайси маҳсулот|какой товар|какая услуга)/i,
  budget: /(byudjet|бюджет)/i,
  location: /(shahar|hudud|шаҳар|ҳудуд|город|район)/i,
};

const EXTRACTED_KEYS = ["name", "email", "product", "interest", "budget", "location", "extra_field"] as const;

export async function runJavobAiSandbox(workspaceId: string, input: SandboxInput): Promise<SandboxResult> {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: input.instagramAccountId, workspaceId },
    select: { id: true, workspaceId: true },
  });
  if (!account) throw new Error("Instagram akkaunt topilmadi");
  const profileRow = await findProfile(workspaceId, account.id);
  if (!profileRow) throw new Error("Bu akkaunt uchun assistent profili (bilimlar bazasi) yo'q");

  // Split the transcript: the trailing customer messages are this turn.
  const messages = input.messages.filter((m) => m.text.trim());
  let split = messages.length;
  while (split > 0 && messages[split - 1].role === "customer") split--;
  const turnMessages = messages.slice(split);
  if (turnMessages.length === 0) throw new Error("Oxirgi xabar mijozniki bo'lishi kerak");
  const earlier = messages.slice(0, split);
  const customerText = turnMessages.map((m) => m.text.trim()).join("\n");
  const assistantEarlier = earlier.filter((m) => m.role === "assistant");

  // Budget gate (4.4), once per turn, before any model call.
  const gate = await enforceBudgetBeforeCall(workspaceId);
  const caps = perTurnCaps(gate.status);
  const extracted: ExtractedFields = {};
  for (const key of EXTRACTED_KEYS) {
    const value = input.contactState?.extracted?.[key];
    if (typeof value === "string" && value.trim()) extracted[key] = value.trim();
  }
  if (!gate.allowed) {
    return {
      reply: `⛔ ${gate.reason ?? "AI byudjeti tugadi"} — JavobAI LIVE rejimda mijozga bir marta shablon yuborib, suhbatni menejerga topshiradi.`,
      intent: "other",
      confidence: 0,
      usedFacts: [],
      extracted: Object.fromEntries(EXTRACTED_KEYS.map((k) => [k, extracted[k] ?? null])),
      language: "uz_latn",
      score: Math.max(0, Math.min(100, Math.round(input.contactState?.score ?? 0))),
      temperature: "COLD",
      signals: [],
      handoff: { needed: true, reason: "budget" },
      unknownQuestion: null,
      blockedBy: "budget",
      costUsd: 0,
      budgetStatus: gate.status,
    };
  }

  const [config, scoring, rules, kb] = await Promise.all([
    loadAccountConfig(account.id),
    loadScoringConfig(workspaceId, account.id),
    loadHandoffRules(workspaceId),
    loadKnowledgeBlock(profileRow.id, customerText, caps.maxKbChars),
  ]);
  if (!kb) throw new Error("Bilimlar bazasi yuklanmadi");

  const collected: Collected = {};
  for (const m of earlier) {
    if (m.role !== "customer") continue;
    const phone = extractPhone(m.text);
    if (phone) {
      collected.phone_e164 = phone.e164;
      collected.phone_raw = phone.raw;
    }
  }
  if (extracted.name) collected.name = extracted.name;
  if (extracted.product) collected.product_interest = extracted.product;

  const replyModel = modelForTask("reply", gate.status);
  const retryModel = modelForTask("retry_low_confidence", gate.status);
  const result = await runJavobAiTurn({
    kb,
    config,
    scoring,
    rules,
    state: {
      handoffState: "AI_ACTIVE",
      score: Math.max(0, Math.min(100, Math.round(input.contactState?.score ?? 0))),
      extracted,
      unknownStreak: 0,
      turns: assistantEarlier.length,
      countedSignals: [],
      phoneAskCount: assistantEarlier.filter((m) => PHONE_ASK.test(m.text)).length,
      askedFields: (Object.keys(FIELD_ASK) as QualificationField[]).filter((f) => assistantEarlier.some((m) => FIELD_ASK[f].test(m.text))),
      postHandoffReplies: 0,
    },
    collected,
    memory: { summary: "", facts: {}, returning: false },
    context: {},
    history: earlier.map((m) => ({ role: m.role === "customer" ? ("user" as const) : ("assistant" as const), content: m.text.trim() })),
    customerText,
    hasMedia: false,
    igName: null,
    lastBotMessage: assistantEarlier[assistantEarlier.length - 1]?.text ?? null,
    templateOnly: false,
    llm: replyModel === null ? null : getLlmProviderFor(replyModel),
    llmRetry: retryModel && retryModel !== replyModel ? getLlmProviderFor(retryModel) : null,
    caps,
  });

  for (const usage of result.usages) {
    await recordJavobAiUsage({ workspaceId, conversationId: null, kind: input.usageKind ?? USAGE_KIND_SANDBOX, ...usage });
  }

  return {
    reply: result.reply ?? "",
    intent: result.intent,
    confidence: result.confidence,
    usedFacts: result.usedFacts,
    extracted: Object.fromEntries(EXTRACTED_KEYS.map((k) => [k, result.extracted[k] ?? null])),
    language: result.language,
    score: result.score,
    temperature: result.temperature,
    signals: result.signals,
    handoff: result.handoff,
    unknownQuestion: result.unknownQuestion,
    blockedBy: result.blockedBy,
    costUsd: result.usages.reduce((n, u) => n + u.costUsd, 0),
    budgetStatus: gate.status,
  };
}
