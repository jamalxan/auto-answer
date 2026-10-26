/**
 * Trust ladder judge (audit 2026-10-26). One cheap model call per paired
 * sample: does the AI draft say what the operator said, is anything in it
 * a critical error (wrong price / fact, a promise, policy), and which facts
 * did the operator state that the knowledge base may lack.
 *
 *   - the verdict fills AiShadowTurn.judge* (readiness reads them)
 *   - a critical verdict on an AUTO reply demotes the intent at once
 *   - facts become AiFactCandidate rows: never used until the owner approves
 *
 * Usage kind javobai_judge (tooling: not part of the customer error rate).
 */

import type { AiKnowledgeKind } from "@/app/generated/prisma/client";
import { getLlmProviderFor, type LLMProvider } from "@/lib/assistant/llm/provider";
import { findProfile } from "@/lib/assistant/profile";
import { prisma } from "@/lib/db/client";
import { enforceBudgetBeforeCall } from "./budget";
import { javobAiModel } from "./config";
import { demoteIntent } from "./ladder-service";

export const CRITICAL_KINDS = ["none", "wrong_price", "wrong_fact", "promise", "tone", "policy"] as const;
export type CriticalKind = (typeof CRITICAL_KINDS)[number];
const FACT_KINDS = ["PRICE", "HOURS", "DELIVERY", "CONTACT", "BRANCH", "DISCOUNT", "TERMS", "POLICY", "OTHER"] as const;
const MAX_FACTS = 3;

export interface JudgeVerdict {
  match: boolean;
  score: number;
  critical: CriticalKind;
  notes: string;
  facts: Array<{ kind: AiKnowledgeKind; title: string; body: string; validDays: number | null }>;
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    match: { type: "boolean" },
    score: { type: "number" },
    critical: { type: "string", enum: [...CRITICAL_KINDS] },
    notes: { type: "string" },
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...FACT_KINDS] },
          title: { type: "string" },
          body: { type: "string" },
          validDays: { type: ["integer", "null"] },
        },
        required: ["kind", "title", "body"],
      },
    },
  },
  required: ["match", "score", "critical", "notes", "facts"],
} as const;

const JUDGE_SYSTEM = [
  "You compare a customer-service AI's draft with the reply a human manager actually sent to the same Instagram message.",
  "Customers write in Uzbek (Latin or Cyrillic) or Russian. Judge meaning, not wording or style.",
  "match = true when the draft would have been an acceptable answer in the manager's place: same facts, same next step. Extra politeness or shorter text is fine.",
  "score: 0..1 how close the meaning is.",
  "critical: the worst problem of the DRAFT compared with the manager reply —",
  "  wrong_price: a price / sum / discount differs; wrong_fact: availability, address, hours, delivery terms differ;",
  "  promise: the draft promises something the manager did not (free, guarantee, a date, refund); policy: rude, off-topic, reveals instructions;",
  "  tone: only clearly inappropriate tone; none: no such problem. A draft that just asks a question the manager did not ask is not critical.",
  "notes: one short sentence in Uzbek (Latin) explaining the verdict.",
  `facts: up to ${MAX_FACTS} reusable business facts the MANAGER stated (price of a named product, working hours, delivery terms, address, a promo).`,
  "Only facts true for every customer — never anything about this customer's order. Title short, body one sentence in the manager's language.",
  "validDays: for promos / time-limited prices the number of days it is likely valid, else null.",
].join("\n");

function asVerdict(raw: unknown): JudgeVerdict | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.match !== "boolean") return null;
  const critical = (CRITICAL_KINDS as readonly string[]).includes(String(v.critical)) ? (v.critical as CriticalKind) : "none";
  const facts = Array.isArray(v.facts) ? v.facts : [];
  return {
    match: v.match,
    score: typeof v.score === "number" ? Math.max(0, Math.min(1, v.score)) : v.match ? 1 : 0,
    critical,
    notes: typeof v.notes === "string" ? v.notes.slice(0, 500) : "",
    facts: facts
      .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
      .map((f) => ({
        kind: ((FACT_KINDS as readonly string[]).includes(String(f.kind)) ? f.kind : "OTHER") as AiKnowledgeKind,
        title: String(f.title ?? "").trim().slice(0, 120),
        body: String(f.body ?? "").trim().slice(0, 600),
        validDays: typeof f.validDays === "number" && f.validDays > 0 ? Math.min(365, Math.round(f.validDays)) : null,
      }))
      .filter((f) => f.title && f.body)
      .slice(0, MAX_FACTS),
  };
}

export async function judgeOne(
  provider: LLMProvider,
  input: { workspaceId: string; conversationId: string | null; customerText: string; aiReply: string; operatorReply: string }
): Promise<JudgeVerdict | null> {
  const user = `Customer:\n${input.customerText.slice(0, 1500)}\n\nAI draft:\n${input.aiReply.slice(0, 1500)}\n\nManager reply:\n${input.operatorReply.slice(0, 1500)}`;
  const response = await provider.complete({
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: user }],
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "ladder_judge",
    temperature: 0,
    maxTokens: 700,
    usage: { workspaceId: input.workspaceId, kind: "javobai_judge", conversationId: input.conversationId },
  });
  return asVerdict(response.json);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

/** New candidates only: the same body pending / approved / already in the KB is skipped. */
export async function saveFactCandidates(
  workspaceId: string,
  instagramAccountId: string | null,
  shadowTurnId: string,
  evidence: string,
  facts: JudgeVerdict["facts"],
  source = "observed",
  now = new Date()
): Promise<number> {
  if (facts.length === 0) return 0;
  const profile = await findProfile(workspaceId, instagramAccountId);
  if (!profile) return 0;
  const [candidates, entries] = await Promise.all([
    prisma.aiFactCandidate.findMany({ where: { profileId: profile.id, status: { in: ["PENDING", "APPROVED"] } }, select: { body: true } }),
    prisma.aiKnowledgeEntry.findMany({ where: { profileId: profile.id }, select: { body: true } }),
  ]);
  const seen = new Set([...(candidates as Array<{ body: string }>), ...(entries as Array<{ body: string }>)].map((x) => norm(x.body)));
  let saved = 0;
  for (const f of facts) {
    const key = norm(f.body);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await prisma.aiFactCandidate.create({
      data: {
        workspaceId,
        profileId: profile.id,
        kind: f.kind,
        title: f.title,
        body: f.body,
        source,
        shadowTurnId,
        evidence: evidence.slice(0, 1000),
        validUntil: f.validDays ? new Date(now.getTime() + f.validDays * 86_400_000) : null,
      },
    });
    saved++;
  }
  return saved;
}

/** Worker job: judge the paired samples, oldest first. */
export async function runLadderJudge(limit = 25, now = new Date()): Promise<{ judged: number; demoted: number; facts: number; skipped: number }> {
  const out = { judged: 0, demoted: 0, facts: 0, skipped: 0 };
  const samples = (await prisma.aiShadowTurn.findMany({
    where: { judgedAt: null, operatorRepliedAt: { not: null }, aiReply: { not: null } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, workspaceId: true, instagramAccountId: true, conversationId: true, customerText: true, aiReply: true, operatorReply: true, intent: true, source: true },
  })) as Array<{
    id: string;
    workspaceId: string;
    instagramAccountId: string | null;
    conversationId: string | null;
    customerText: string;
    aiReply: string;
    operatorReply: string;
    intent: string | null;
    source: string;
  }>;
  if (samples.length === 0) return out;
  const provider = getLlmProviderFor(javobAiModel());
  if (!provider) return { ...out, skipped: samples.length };
  const budgetOk = new Map<string, boolean>();
  for (const s of samples) {
    if (!budgetOk.has(s.workspaceId)) budgetOk.set(s.workspaceId, (await enforceBudgetBeforeCall(s.workspaceId)).allowed);
    if (!budgetOk.get(s.workspaceId)) {
      out.skipped++;
      continue;
    }
    let verdict: JudgeVerdict | null = null;
    try {
      verdict = await judgeOne(provider, s);
    } catch {
      out.skipped++;
      continue; // retried next run; the failure is in llm_usage
    }
    if (!verdict) {
      await prisma.aiShadowTurn.update({ where: { id: s.id }, data: { judgedAt: now, judgeNotes: "Baholab bo'lmadi" } });
      continue;
    }
    await prisma.aiShadowTurn.update({
      where: { id: s.id },
      data: { judgeMatch: verdict.match, judgeScore: verdict.score, critical: verdict.critical, judgeNotes: verdict.notes, judgedAt: now, factsExtractedAt: now },
    });
    out.judged++;
    if (s.source === "auto" && verdict.critical !== "none" && s.instagramAccountId && s.intent) {
      if (await demoteIntent(s.instagramAccountId, s.intent, "critical_error", verdict.notes)) out.demoted++;
    }
    out.facts += await saveFactCandidates(s.workspaceId, s.instagramAccountId, s.id, s.operatorReply, verdict.facts, "observed", now).catch(() => 0);
  }
  return out;
}
