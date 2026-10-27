/**
 * Trust ladder — the database side of ladder.ts (audit 2026-10-26).
 *
 *   policies   AiIntentPolicy per (account, intent); no row = OBSERVE
 *   samples    AiShadowTurn rows with source observe | copilot | auto | shadow
 *   drafts     AiDraft (COPILOT): a human sends, edits or drops it
 *   pairing    the operator's next message after a sample is its reference
 *   demotion   AUTO → COPILOT on a critical judge verdict, an expired fact or complaints
 *
 * Sending a draft lives in runtime.ts (it owns the Instagram delivery path);
 * the judge in judge.ts. Nothing here talks to Instagram.
 */

import type { AiLadderMode } from "@/app/generated/prisma/client";
import { findProfile } from "@/lib/assistant/profile";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { INTENTS } from "./config";
import { loadKnowledgeBlock } from "./knowledge";
import {
  DEMOTE_REASON_TEXT,
  INTENT_RULES,
  LADDER_COMPLAINT_WINDOW,
  LADDER_CRITICAL_WINDOW,
  allowedModes,
  complaintRateTooHigh,
  factCoverage,
  readiness,
  ruleFor,
  type DemoteReason,
  type FactCoverage,
  type LadderMode,
  type Readiness,
} from "./ladder";
import { VALIDATION_ISSUE_TEXT, type ValidationIssue } from "./validate";

const MINUTE_MS = 60_000;
/** An operator message this long after the sample no longer answers that customer message. */
export const PAIR_WINDOW_MS = 2 * 60 * MINUTE_MS;
/** A PENDING draft older than this is stale (the customer moved on or the window closed). */
export const DRAFT_TTL_MS = 23 * 60 * MINUTE_MS;

export class LadderError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// ─── Policies ─────────────────────────────────────────────────────────────────

export async function loadIntentMode(instagramAccountId: string, intent: string | null): Promise<LadderMode> {
  if (!intent) return "OBSERVE";
  const row = await prisma.aiIntentPolicy.findUnique({ where: { instagramAccountId_intent: { instagramAccountId, intent } }, select: { mode: true } });
  return (row?.mode as LadderMode | undefined) ?? "OBSERVE";
}

export interface IntentOverview {
  intent: string;
  label: string;
  neverAuto: boolean;
  early: boolean;
  mode: LadderMode;
  allowed: LadderMode[];
  readiness: Readiness;
  demotedAt: Date | null;
  demoteReason: string | null;
  changedBy: string | null;
  changedAt: Date | null;
}

async function coverageFor(profileId: string | null): Promise<FactCoverage> {
  const kb = profileId ? await loadKnowledgeBlock(profileId).catch(() => null) : null;
  if (!kb) return { price: false, product: false, delivery: false, business: false };
  return factCoverage({
    products: kb.profile.products.map((p) => ({ price: p.price ?? null })),
    faqs: kb.profile.faqs,
    delivery: kb.profile.delivery,
    address: kb.profile.address,
    workingHours: kb.profile.workingHours,
    entries: kb.entries,
  });
}

async function profileIdFor(workspaceId: string, instagramAccountId: string): Promise<string | null> {
  return (await findProfile(workspaceId, instagramAccountId))?.id ?? null;
}

/** Every intent of one account: its mode, how close it is to AUTO, what is missing. */
export async function ladderOverview(workspaceId: string, instagramAccountId: string): Promise<IntentOverview[]> {
  const [policies, samples, coverage] = await Promise.all([
    prisma.aiIntentPolicy.findMany({ where: { workspaceId, instagramAccountId } }),
    prisma.aiShadowTurn.findMany({
      where: { workspaceId, instagramAccountId, intent: { not: null }, operatorRepliedAt: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: { intent: true, judgeMatch: true, critical: true, createdAt: true },
    }),
    profileIdFor(workspaceId, instagramAccountId).then(coverageFor),
  ]);
  const byIntent = new Map<string, Array<{ judgeMatch: boolean | null; critical: string | null; createdAt: Date }>>();
  for (const s of samples as Array<{ intent: string | null; judgeMatch: boolean | null; critical: string | null; createdAt: Date }>) {
    const key = s.intent ?? "other";
    const list = byIntent.get(key) ?? [];
    list.push(s);
    byIntent.set(key, list);
  }
  return INTENTS.map((intent) => {
    const policy = (policies as Array<{ intent: string; mode: AiLadderMode; demotedAt: Date | null; demoteReason: string | null; changedBy: string | null; changedAt: Date | null }>).find(
      (p) => p.intent === intent
    );
    const r = readiness(intent, byIntent.get(intent) ?? [], coverage);
    const rule = INTENT_RULES[intent];
    return {
      intent,
      label: rule.label,
      neverAuto: rule.neverAuto,
      early: rule.early,
      mode: (policy?.mode as LadderMode | undefined) ?? "OBSERVE",
      allowed: allowedModes(intent, r),
      readiness: r,
      demotedAt: policy?.demotedAt ?? null,
      demoteReason: policy?.demoteReason ?? null,
      changedBy: policy?.changedBy ?? null,
      changedAt: policy?.changedAt ?? null,
    };
  });
}

/** The owner's switch. AUTO only when the intent is ready right now. */
export async function setIntentMode(workspaceId: string, instagramAccountId: string, intent: string, mode: LadderMode, by: string): Promise<IntentOverview> {
  if (!(INTENTS as readonly string[]).includes(intent)) throw new LadderError(400, "Noma'lum intent");
  const account = await prisma.instagramAccount.findFirst({ where: { id: instagramAccountId, workspaceId }, select: { id: true } });
  if (!account) throw new LadderError(404, "Akkaunt topilmadi");
  const overview = (await ladderOverview(workspaceId, instagramAccountId)).find((o) => o.intent === intent)!;
  if (!overview.allowed.includes(mode)) {
    throw new LadderError(409, overview.readiness.missing[0] ?? "Bu rejim hozir mumkin emas");
  }
  if (mode === "AUTO") {
    // Tariff (phase 8): Start is observe + copilot only.
    const { assertAiAuto, PlanLimitError } = await import("@/lib/billing/limits");
    await assertAiAuto(workspaceId).catch((error: unknown) => {
      throw error instanceof PlanLimitError ? new LadderError(402, error.message) : error;
    });
  }
  await prisma.aiIntentPolicy.upsert({
    where: { instagramAccountId_intent: { instagramAccountId, intent } },
    create: { workspaceId, instagramAccountId, intent, mode, changedBy: by, changedAt: new Date() },
    update: { mode, changedBy: by, changedAt: new Date(), ...(mode === "AUTO" ? { demotedAt: null, demoteReason: null } : {}) },
  });
  return { ...overview, mode, changedBy: by, changedAt: new Date() };
}

/** AUTO → COPILOT, once, with the reason; the managers hear about it. Returns whether it changed. */
export async function demoteIntent(instagramAccountId: string, intent: string, reason: DemoteReason, detail?: string): Promise<boolean> {
  const changed = await prisma.aiIntentPolicy.updateMany({
    where: { instagramAccountId, intent, mode: "AUTO" },
    data: { mode: "COPILOT", demotedAt: new Date(), demoteReason: reason, changedBy: "system", changedAt: new Date() },
  });
  if (changed.count === 0) return false;
  const account = await prisma.instagramAccount.findUnique({ where: { id: instagramAccountId }, select: { workspaceId: true, username: true } });
  if (account) {
    const html =
      `⚠️ <b>JavobAI: avto-javob to'xtatildi</b>\nAkkaunt: @${esc(account.username ?? "")}\nMavzu: ${esc(ruleFor(intent).label)}\n` +
      `Sabab: ${esc(DEMOTE_REASON_TEXT[reason])}${detail ? `\n${esc(detail.slice(0, 300))}` : ""}\n` +
      `Endi bu mavzudagi javoblar qoralama bo'lib keladi (copilot).`;
    await notifyWorkspaceChats(account.workspaceId, html).catch(() => 0);
  }
  return true;
}

/**
 * Every few minutes: an AUTO intent whose needed fact disappeared (expired or
 * switched off) or whose auto replies draw complaints falls back to COPILOT.
 */
export async function runLadderChecks(now = new Date()): Promise<{ demoted: number }> {
  const autos = (await prisma.aiIntentPolicy.findMany({ where: { mode: "AUTO" }, select: { workspaceId: true, instagramAccountId: true, intent: true } })) as Array<{
    workspaceId: string;
    instagramAccountId: string;
    intent: string;
  }>;
  let demoted = 0;
  const coverageCache = new Map<string, FactCoverage>();
  for (const p of autos) {
    const need = ruleFor(p.intent).needs;
    if (need) {
      let coverage = coverageCache.get(p.instagramAccountId);
      if (!coverage) {
        coverage = await coverageFor(await profileIdFor(p.workspaceId, p.instagramAccountId));
        coverageCache.set(p.instagramAccountId, coverage);
      }
      if (!coverage[need] && (await demoteIntent(p.instagramAccountId, p.intent, "fact_expired"))) {
        demoted++;
        continue;
      }
    }
    // Complaints after auto replies: the same conversation's next sample is a complaint.
    const recent = (await prisma.aiShadowTurn.findMany({
      where: { instagramAccountId: p.instagramAccountId, source: "auto", intent: p.intent, createdAt: { lte: now } },
      orderBy: { createdAt: "desc" },
      take: LADDER_COMPLAINT_WINDOW,
      select: { conversationId: true, createdAt: true },
    })) as Array<{ conversationId: string | null; createdAt: Date }>;
    if (recent.length < 10) continue;
    let complaints = 0;
    for (const r of recent) {
      if (!r.conversationId) continue;
      const next = await prisma.aiShadowTurn.findFirst({
        where: { conversationId: r.conversationId, createdAt: { gt: r.createdAt } },
        orderBy: { createdAt: "asc" },
        select: { intent: true },
      });
      if (next?.intent === "complaint") complaints++;
    }
    if (complaintRateTooHigh(recent.length, complaints) && (await demoteIntent(p.instagramAccountId, p.intent, "complaints", `${complaints}/${recent.length}`))) demoted++;
  }
  return { demoted };
}

// ─── Samples & drafts ─────────────────────────────────────────────────────────

export interface SampleInput {
  workspaceId: string;
  instagramAccountId: string;
  conversationId: string;
  customerMessageId: string | null;
  customerText: string;
  aiReply: string | null;
  intent: string | null;
  confidence: number | null;
  score: number | null;
  handoff: string | null;
  costUsd: number;
  source: "observe" | "copilot" | "auto";
  /** Validator hits (a draft that would have been sent), kept as judge notes. */
  issues?: ValidationIssue[];
}

export async function recordLadderSample(input: SampleInput): Promise<string> {
  const row = await prisma.aiShadowTurn.create({
    data: {
      workspaceId: input.workspaceId,
      instagramAccountId: input.instagramAccountId,
      conversationId: input.conversationId,
      customerMessageId: input.customerMessageId,
      customerText: input.customerText.slice(0, 4000),
      aiReply: input.aiReply,
      intent: input.intent,
      confidence: input.confidence,
      score: input.score,
      handoff: input.handoff,
      costUsd: input.costUsd,
      source: input.source,
      judgeNotes: input.issues?.length ? input.issues.map((i) => VALIDATION_ISSUE_TEXT[i]).join("; ") : null,
    },
    select: { id: true },
  });
  return row.id;
}

export interface DraftInput extends Omit<SampleInput, "source"> {
  who: string;
}

/** COPILOT: the sample, the draft (older pending drafts of the thread are superseded) and the Telegram card. */
export async function createDraft(input: DraftInput): Promise<string> {
  await prisma.aiDraft.updateMany({ where: { conversationId: input.conversationId, status: "PENDING" }, data: { status: "SUPERSEDED", decidedAt: new Date() } });
  const shadowTurnId = await recordLadderSample({ ...input, source: "copilot" });
  const draft = await prisma.aiDraft.create({
    data: {
      workspaceId: input.workspaceId,
      instagramAccountId: input.instagramAccountId,
      conversationId: input.conversationId,
      shadowTurnId,
      text: input.aiReply ?? "",
      intent: input.intent,
      confidence: input.confidence,
    },
    select: { id: true },
  });
  const issues = input.issues?.length ? `\n⚠️ ${esc(input.issues.map((i) => VALIDATION_ISSUE_TEXT[i]).join(", "))}` : "";
  const html =
    `✍️ <b>JavobAI qoralama</b> — ${esc(ruleFor(input.intent).label)}\nMijoz: ${esc(input.who)}\n` +
    `<i>${esc(input.customerText.slice(0, 300))}</i>\n\n${esc((input.aiReply ?? "").slice(0, 900))}${issues}`;
  await notifyWorkspaceChats(input.workspaceId, html, {
    keyboard: [
      [
        { text: "✅ Yuborish", callback_data: `jai:dsend:${draft.id}` },
        { text: "✏️ Tahrirlash", callback_data: `jai:dedit:${draft.id}` },
        { text: "✖", callback_data: `jai:ddrop:${draft.id}` },
      ],
      [{ text: "💬 Instagram suhbat", url: `${getBaseUrl()}/inbox?conversation=${input.conversationId}` }],
    ],
  }).catch(() => 0);
  return draft.id;
}

export async function discardDraft(workspaceId: string, draftId: string, by: string): Promise<boolean> {
  const changed = await prisma.aiDraft.updateMany({ where: { id: draftId, workspaceId, status: "PENDING" }, data: { status: "DISCARDED", decidedBy: by, decidedAt: new Date() } });
  return changed.count > 0;
}

export async function listDrafts(workspaceId: string, status: "PENDING" | "ALL" = "PENDING") {
  return prisma.aiDraft.findMany({
    where: { workspaceId, ...(status === "PENDING" ? { status: "PENDING" as const } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/** Drafts nobody touched within the reply window: closed so the queue shows only live ones. */
export async function expireStaleDrafts(now = new Date()): Promise<number> {
  const result = await prisma.aiDraft.updateMany({ where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - DRAFT_TTL_MS) } }, data: { status: "EXPIRED", decidedAt: now } });
  return result.count;
}

// ─── Pairing (what the human actually answered) ───────────────────────────────

/**
 * Each unpaired sample gets the first operator message after its customer
 * message, if it came before the customer wrote again and within the window.
 * Production stores the operator's Instagram echo / inbox send as an
 * OPERATOR message, so no webhook plumbing is needed.
 */
export async function pairOperatorReplies(now = new Date(), limit = 200): Promise<number> {
  const since = new Date(now.getTime() - 3 * 24 * 60 * MINUTE_MS);
  const samples = (await prisma.aiShadowTurn.findMany({
    where: { operatorReply: null, conversationId: { not: null }, createdAt: { gte: since, lte: new Date(now.getTime() - MINUTE_MS) }, source: { in: ["observe", "copilot", "auto", "shadow"] } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, conversationId: true, customerMessageId: true, createdAt: true },
  })) as Array<{ id: string; conversationId: string; customerMessageId: string | null; createdAt: Date }>;
  let paired = 0;
  for (const s of samples) {
    const anchor = s.customerMessageId
      ? await prisma.conversationMessage.findUnique({ where: { id: s.customerMessageId }, select: { createdAt: true } })
      : null;
    const from = anchor?.createdAt ?? new Date(s.createdAt.getTime() - MINUTE_MS);
    const after = (await prisma.conversationMessage.findMany({
      where: { conversationId: s.conversationId, createdAt: { gt: from } },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { author: true, text: true, createdAt: true },
    })) as Array<{ author: string; text: string; createdAt: Date }>;
    const firstCustomer = after.find((m) => m.author === "CUSTOMER");
    const operator = after.find((m) => m.author === "OPERATOR" && (!firstCustomer || m.createdAt < firstCustomer.createdAt));
    if (operator && operator.createdAt.getTime() - from.getTime() <= PAIR_WINDOW_MS) {
      await prisma.aiShadowTurn.update({ where: { id: s.id }, data: { operatorReply: operator.text.slice(0, 4000), operatorRepliedAt: operator.createdAt } });
      paired++;
    } else if (firstCustomer || now.getTime() - from.getTime() > PAIR_WINDOW_MS) {
      // Nobody answered this one: it can never be paired; mark it judged-out so it leaves the queue.
      await prisma.aiShadowTurn.update({ where: { id: s.id }, data: { operatorReply: "", operatorRepliedAt: null, judgedAt: now, judgeNotes: "Operator javob bermadi" } });
    }
  }
  return paired;
}

/** Recent critical verdicts per intent (the UI's "why not AUTO"). */
export async function recentCriticalSamples(workspaceId: string, instagramAccountId: string, take = 20) {
  return prisma.aiShadowTurn.findMany({
    where: { workspaceId, instagramAccountId, critical: { notIn: ["none"], not: null } },
    orderBy: { createdAt: "desc" },
    take: Math.min(take, LADDER_CRITICAL_WINDOW),
    select: { id: true, intent: true, customerText: true, aiReply: true, operatorReply: true, critical: true, judgeNotes: true, createdAt: true },
  });
}
