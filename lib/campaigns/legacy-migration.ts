/**
 * Legacy campaign → Comment 2.0 engine (audit 2026-10-26, "uchta parallel
 * dvigatel" → one engine). Three steps, each reversible:
 *
 *   1. plan    — pure: map one old `Automation` onto a `TriggerCampaign`
 *                (+ public-reply variants, follow-up step). Anything the new
 *                engine cannot do the same way is a BLOCKER (no migration) or
 *                a NOTE (migrates, behaviour differs slightly; owner accepts).
 *   2. shadow  — the copy is created switched OFF; for every comment on the
 *                account the production worker records whether the old engine
 *                matched and whether the copy would have (`recordShadowSamples`).
 *                Nobody gets a second message: the copy never sends.
 *   3. cutover — after SHADOW_DAYS with no disagreement (or the owner forces it
 *                with a reason): copy ON + Automation OFF in one transaction.
 *                `rollback` is the exact reverse.
 *
 * Not migrated on purpose (blockers): follow-gating, tracked link buttons,
 * "next Reel" binding and the assistant handoff — the new engine has no
 * equivalent yet, so moving them would silently change what customers get.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { forgetCommentClaims } from "@/lib/triggers/claim";
import { forgetAccountGate } from "@/lib/triggers/ingest";
import { selectCommentCampaign } from "@/lib/triggers/matching";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

/** Two weeks of parallel monitoring before an unforced cutover (audit: PM warning). */
export const SHADOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the follow-up editor's ceiling (Meta 24 h window). */
const FOLLOW_UP_MAX_MINUTES = 23 * 60;

export interface LegacyAutomation {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  name: string;
  postId: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  dmTriggerEnabled: boolean;
  handoffToAssistant: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  isActive: boolean;
  scheduledPostId: string | null;
  /** Count of tracked links (a link button sends one). */
  trackedLinkCount?: number;
}

export interface MigrationPlan {
  blockers: string[];
  notes: string[];
  campaign: {
    name: string;
    instagramAccountId: string;
    keywords: string[];
    matchingMode: "EVERY" | "CONTAINS";
    mediaScope: "ANY" | "SPECIFIC";
    mediaIds: string[];
    responseMessage: string;
    openingButtonLabel: string | null;
    mainMessage: string | null;
    publicReplyEnabled: boolean;
    scheduledPostId: string | null;
  };
  publicReplies: string[];
  followUp: { delayMinutes: number; message: string } | null;
}

export function planLegacyMigration(a: LegacyAutomation): MigrationPlan {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (a.requireFollow) blockers.push("\"Obuna bo'lishni talab qilish\" yangi dvigatelda hali yo'q");
  if (a.linkButtonLabel || (a.trackedLinkCount ?? 0) > 0) blockers.push("Kuzatiladigan havola tugmasi (tracked link) yangi dvigatelda hali yo'q");
  if (a.pendingNextReel) blockers.push("\"Keyingi Reels'ga bog'lash\" yangi dvigatelda yo'q");
  if (a.handoffToAssistant) blockers.push("Javob berganlarni AI assistentga topshirish yangi dvigatelda kampaniya darajasida yo'q");
  if (a.dmTriggerEnabled) blockers.push("DM kalit so'z triggeri alohida Direct kampaniya sifatida qo'lda yaratilishi kerak");
  if (!a.matchAnyWord && a.keywords.length === 0) blockers.push("Kalit so'zlar yo'q va \"har qanday so'z\" o'chiq — kampaniya hech qachon ishlamaydi");
  if (!a.postId && !a.matchAnyPost && !a.scheduledPostId) blockers.push("Post tanlanmagan");

  if (!a.matchAnyWord && !a.wholeWordMatch) {
    notes.push("Eski kampaniya so'z ichidagi moslikni ham qabul qilardi; yangisi CONTAINS rejimida so'z chegarasini hisobga olishi mumkin — shadow taqqoslash farqni ko'rsatadi");
  }
  if (a.followUpEnabled && a.followUpMessage) {
    notes.push("Follow-up vaqti eskisida havola yuborilgandan, yangisida xabar yuborilgan / tugma bosilgan paytdan hisoblanadi");
    if (a.followUpDelayMinutes > FOLLOW_UP_MAX_MINUTES) notes.push(`Follow-up kechikishi ${FOLLOW_UP_MAX_MINUTES} daqiqaga qisqartirildi (Meta 24 soat oynasi)`);
  }

  const opening = a.openingDmEnabled && a.openingDmMessage && a.openingDmButtonLabel;
  const publicReplies = a.publicReplyEnabled
    ? (a.publicReplyMessages.length > 0 ? a.publicReplyMessages : a.publicReplyMessage ? [a.publicReplyMessage] : []).map((t) => t.trim()).filter(Boolean)
    : [];
  if (a.publicReplyEnabled && publicReplies.length === 0) notes.push("Ochiq javob yoqilgan, lekin matni yo'q — yangisida o'chiq");

  return {
    blockers,
    notes,
    campaign: {
      name: `${a.name} (ko'chirilgan)`.slice(0, 80),
      instagramAccountId: a.instagramAccountId,
      keywords: a.matchAnyWord ? [] : a.keywords,
      matchingMode: a.matchAnyWord ? "EVERY" : "CONTAINS",
      mediaScope: a.matchAnyPost ? "ANY" : "SPECIFIC",
      mediaIds: a.matchAnyPost || !a.postId ? [] : [a.postId],
      responseMessage: opening ? (a.openingDmMessage as string) : a.dmMessage,
      openingButtonLabel: opening ? (a.openingDmButtonLabel as string) : null,
      mainMessage: opening ? a.dmMessage : null,
      publicReplyEnabled: publicReplies.length > 0,
      scheduledPostId: a.postId ? null : a.scheduledPostId,
    },
    publicReplies,
    followUp: a.followUpEnabled && a.followUpMessage ? { delayMinutes: Math.min(Math.max(0, a.followUpDelayMinutes), FOLLOW_UP_MAX_MINUTES), message: a.followUpMessage } : null,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class LegacyMigrationError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const AUTOMATION_SELECT = {
  id: true,
  workspaceId: true,
  instagramAccountId: true,
  name: true,
  postId: true,
  pendingNextReel: true,
  matchAnyPost: true,
  keywords: true,
  matchAnyWord: true,
  wholeWordMatch: true,
  dmTriggerEnabled: true,
  handoffToAssistant: true,
  dmMessage: true,
  openingDmEnabled: true,
  openingDmMessage: true,
  openingDmButtonLabel: true,
  linkButtonLabel: true,
  requireFollow: true,
  followUpEnabled: true,
  followUpMessage: true,
  followUpDelayMinutes: true,
  publicReplyEnabled: true,
  publicReplyMessage: true,
  publicReplyMessages: true,
  isActive: true,
  scheduledPostId: true,
  _count: { select: { trackedLinks: true } },
} as const;

async function loadAutomation(workspaceId: string, automationId: string): Promise<LegacyAutomation> {
  const row = await prisma.automation.findFirst({ where: { id: automationId, workspaceId }, select: AUTOMATION_SELECT });
  if (!row) throw new LegacyMigrationError(404, "Eski kampaniya topilmadi");
  const { _count, ...rest } = row as typeof row & { _count?: { trackedLinks?: number } };
  return { ...rest, trackedLinkCount: _count?.trackedLinks ?? 0 } as LegacyAutomation;
}

export interface MigrationStats {
  samples: number;
  agreed: number;
  legacyOnly: number;
  newOnly: number;
}

export interface MigrationView {
  automationId: string;
  automationName: string;
  automationActive: boolean;
  plan: { blockers: string[]; notes: string[] };
  migration: {
    id: string;
    status: "SHADOW" | "CUTOVER" | "ROLLED_BACK";
    triggerCampaignId: string;
    shadowStartedAt: Date;
    cutoverAt: Date | null;
    rolledBackAt: Date | null;
    forcedReason: string | null;
    notes: string[];
    stats: MigrationStats;
    daysInShadow: number;
    readyForCutover: boolean;
    disagreements: Array<{ commentText: string; legacyMatched: boolean; newMatched: boolean; createdAt: Date }>;
  } | null;
}

export async function migrationStats(migrationId: string): Promise<MigrationStats> {
  const rows = (await prisma.legacyMigrationSample.findMany({ where: { migrationId }, select: { legacyMatched: true, newMatched: true } })) as Array<{ legacyMatched: boolean; newMatched: boolean }>;
  return {
    samples: rows.length,
    agreed: rows.filter((r) => r.legacyMatched === r.newMatched).length,
    legacyOnly: rows.filter((r) => r.legacyMatched && !r.newMatched).length,
    newOnly: rows.filter((r) => !r.legacyMatched && r.newMatched).length,
  };
}

/** Clean comparison for long enough: the copy may take over without a forced reason. */
export function isReadyForCutover(stats: MigrationStats, shadowStartedAt: Date, now = new Date()): boolean {
  return now.getTime() - shadowStartedAt.getTime() >= SHADOW_DAYS * DAY_MS && stats.legacyOnly === 0 && stats.newOnly === 0;
}

/** Every legacy campaign of the workspace with its plan and migration state. */
export async function listLegacyMigrations(workspaceId: string, now = new Date()): Promise<MigrationView[]> {
  const automations = (await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 100,
    select: AUTOMATION_SELECT,
  })) as Array<LegacyAutomation & { _count?: { trackedLinks?: number } }>;
  const migrations = (await prisma.legacyCampaignMigration.findMany({ where: { workspaceId } })) as Array<{
    id: string;
    automationId: string;
    status: "SHADOW" | "CUTOVER" | "ROLLED_BACK";
    triggerCampaignId: string;
    shadowStartedAt: Date;
    cutoverAt: Date | null;
    rolledBackAt: Date | null;
    forcedReason: string | null;
    notes: string[];
  }>;
  const byAutomation = new Map(migrations.map((m) => [m.automationId, m]));
  const views: MigrationView[] = [];
  for (const a of automations) {
    const plan = planLegacyMigration({ ...a, trackedLinkCount: a._count?.trackedLinks ?? 0 });
    const m = byAutomation.get(a.id);
    let migration: MigrationView["migration"] = null;
    if (m) {
      const stats = await migrationStats(m.id);
      const disagreements = (await prisma.legacyMigrationSample.findMany({
        where: {
          migrationId: m.id,
          OR: [
            { legacyMatched: true, newMatched: false },
            { legacyMatched: false, newMatched: true },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { commentText: true, legacyMatched: true, newMatched: true, createdAt: true },
      })) as Array<{ commentText: string; legacyMatched: boolean; newMatched: boolean; createdAt: Date }>;
      migration = {
        ...m,
        stats,
        daysInShadow: Math.floor((now.getTime() - new Date(m.shadowStartedAt).getTime()) / DAY_MS),
        readyForCutover: m.status === "SHADOW" && isReadyForCutover(stats, new Date(m.shadowStartedAt), now),
        disagreements,
      };
    }
    views.push({ automationId: a.id, automationName: a.name, automationActive: a.isActive, plan: { blockers: plan.blockers, notes: plan.notes }, migration });
  }
  return views;
}

/** Step 2: create the switched-off copy and start recording. */
export async function startLegacyShadow(workspaceId: string, automationId: string): Promise<{ migrationId: string; triggerCampaignId: string }> {
  const automation = await loadAutomation(workspaceId, automationId);
  const existing = await prisma.legacyCampaignMigration.findUnique({ where: { automationId } });
  if (existing && existing.status !== "ROLLED_BACK") throw new LegacyMigrationError(409, "Bu kampaniya allaqachon ko'chirilmoqda");
  const plan = planLegacyMigration(automation);
  if (plan.blockers.length > 0) throw new LegacyMigrationError(422, `Ko'chirib bo'lmaydi: ${plan.blockers.join("; ")}`);

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // A rolled-back attempt left its copy switched off: replace it with a fresh one built from today's settings.
    if (existing) await tx.triggerCampaign.deleteMany({ where: { id: existing.triggerCampaignId, workspaceId } });
    const campaign = await tx.triggerCampaign.create({
      data: {
        workspaceId,
        instagramAccountId: plan.campaign.instagramAccountId,
        name: plan.campaign.name,
        triggerType: "COMMENT",
        keywords: plan.campaign.keywords,
        matchingMode: plan.campaign.matchingMode,
        mediaScope: plan.campaign.mediaScope,
        mediaIds: plan.campaign.mediaIds,
        responseType: "SEND_MESSAGE",
        responseMessage: plan.campaign.responseMessage,
        openingButtonLabel: plan.campaign.openingButtonLabel,
        mainMessage: plan.campaign.mainMessage,
        publicReplyEnabled: plan.campaign.publicReplyEnabled,
        scheduledPostId: plan.campaign.scheduledPostId,
        active: false,
      },
      select: { id: true },
    });
    if (plan.publicReplies.length > 0) {
      await tx.triggerReplyVariant.createMany({
        data: plan.publicReplies.map((text, sort) => ({ campaignId: campaign.id, kind: "PUBLIC" as const, text, sort, approvedAt: now })),
      });
    }
    if (plan.followUp) {
      await tx.triggerFollowUpStep.create({ data: { campaignId: campaign.id, sort: 0, delayMinutes: plan.followUp.delayMinutes, condition: "ALWAYS", message: plan.followUp.message } });
    }
    const data = { workspaceId, triggerCampaignId: campaign.id, status: "SHADOW" as const, notes: plan.notes, shadowStartedAt: now, cutoverAt: null, rolledBackAt: null, forcedReason: null };
    const migration = existing
      ? await tx.legacyCampaignMigration.update({ where: { id: existing.id }, data })
      : await tx.legacyCampaignMigration.create({ data: { ...data, automationId } });
    if (existing) await tx.legacyMigrationSample.deleteMany({ where: { migrationId: existing.id } });
    return { migrationId: migration.id, triggerCampaignId: campaign.id };
  });
  shadowCache.clear();
  return result;
}

/** Step 3: copy ON, Automation OFF — one transaction. */
export async function cutoverLegacyMigration(workspaceId: string, migrationId: string, options: { force?: boolean; reason?: string } = {}, now = new Date()) {
  const m = await prisma.legacyCampaignMigration.findFirst({ where: { id: migrationId, workspaceId } });
  if (!m) throw new LegacyMigrationError(404, "Ko'chirish topilmadi");
  if (m.status !== "SHADOW") throw new LegacyMigrationError(409, "Faqat kuzatuv (shadow) holatidagi ko'chirishni yakunlash mumkin");
  const stats = await migrationStats(m.id);
  const ready = isReadyForCutover(stats, m.shadowStartedAt, now);
  const reason = options.reason?.trim();
  if (!ready && !(options.force && reason)) {
    throw new LegacyMigrationError(
      409,
      `Hali erta: ${SHADOW_DAYS} kunlik kuzatuv va 0 ta farq kerak (hozir ${Math.floor((now.getTime() - m.shadowStartedAt.getTime()) / DAY_MS)} kun, ${stats.legacyOnly + stats.newOnly} ta farq). Majburan o'tkazish uchun sabab yozing.`
    );
  }
  const campaign = await prisma.triggerCampaign.findFirst({ where: { id: m.triggerCampaignId, workspaceId }, select: { id: true, instagramAccount: { select: { instagramId: true } } } });
  if (!campaign) throw new LegacyMigrationError(409, "Yangi kampaniya o'chirib yuborilgan — ko'chirishni qaytadan boshlang");
  await prisma.$transaction([
    prisma.triggerCampaign.update({ where: { id: campaign.id }, data: { active: true } }),
    prisma.automation.update({ where: { id: m.automationId }, data: { isActive: false } }),
    prisma.legacyCampaignMigration.update({ where: { id: m.id }, data: { status: "CUTOVER", cutoverAt: now, forcedReason: ready ? null : reason } }),
  ]);
  forgetCaches(campaign.instagramAccount?.instagramId);
}

/** The exact reverse of cutover (or abandoning a shadow): copy OFF, Automation back ON. */
export async function rollbackLegacyMigration(workspaceId: string, migrationId: string, now = new Date()) {
  const m = await prisma.legacyCampaignMigration.findFirst({ where: { id: migrationId, workspaceId } });
  if (!m) throw new LegacyMigrationError(404, "Ko'chirish topilmadi");
  if (m.status === "ROLLED_BACK") return;
  const campaign = await prisma.triggerCampaign.findFirst({ where: { id: m.triggerCampaignId, workspaceId }, select: { id: true, instagramAccount: { select: { instagramId: true } } } });
  await prisma.$transaction([
    ...(campaign ? [prisma.triggerCampaign.update({ where: { id: campaign.id }, data: { active: false } })] : []),
    // A shadow never switched the old one off; a cutover did.
    ...(m.status === "CUTOVER" ? [prisma.automation.update({ where: { id: m.automationId }, data: { isActive: true } })] : []),
    prisma.legacyCampaignMigration.update({ where: { id: m.id }, data: { status: "ROLLED_BACK", rolledBackAt: now } }),
  ]);
  forgetCaches(campaign?.instagramAccount?.instagramId);
}

function forgetCaches(instagramId?: string | null) {
  shadowCache.clear();
  if (instagramId) {
    forgetAccountGate(instagramId);
    forgetCommentClaims(instagramId);
  } else {
    forgetCommentClaims();
  }
}

// ─── Shadow recording (production worker hot path) ────────────────────────────

interface ShadowPair {
  migrationId: string;
  automation: { postId: string | null; matchAnyPost: boolean; keywords: string[]; matchAnyWord: boolean; wholeWordMatch: boolean };
  campaign: { id: string; mediaScope: "ANY" | "SPECIFIC"; mediaIds: string[]; keywords: string[]; matchingMode: "EVERY" | "CONTAINS" | "EXACT"; intents: string[]; priority: number; createdAt: Date };
}

const SHADOW_TTL_MS = 30_000;
/** Instagram id → shadow pairs of that account (most accounts: an empty list). */
const shadowCache = new Map<string, { pairs: ShadowPair[]; expires: number }>();

async function loadShadowPairs(instagramId: string): Promise<ShadowPair[]> {
  const hit = shadowCache.get(instagramId);
  if (hit && hit.expires > Date.now()) return hit.pairs;
  const migrations = (await prisma.legacyCampaignMigration.findMany({
    where: { status: "SHADOW", automation: { instagramAccount: { instagramId } } },
    select: {
      id: true,
      triggerCampaignId: true,
      automation: { select: { postId: true, matchAnyPost: true, keywords: true, matchAnyWord: true, wholeWordMatch: true } },
    },
  })) as Array<{ id: string; triggerCampaignId: string; automation: ShadowPair["automation"] }>;
  const campaigns = migrations.length
    ? ((await prisma.triggerCampaign.findMany({
        where: { id: { in: migrations.map((m) => m.triggerCampaignId) } },
        select: { id: true, mediaScope: true, mediaIds: true, keywords: true, matchingMode: true, intents: true, priority: true, createdAt: true },
      })) as ShadowPair["campaign"][])
    : [];
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const pairs = migrations.flatMap((m) => {
    const campaign = byId.get(m.triggerCampaignId);
    // Arrays default to [] in the schema; normalise anyway so the matcher never sees undefined.
    return campaign
      ? [{ migrationId: m.id, automation: { ...m.automation, keywords: m.automation.keywords ?? [] }, campaign: { ...campaign, keywords: campaign.keywords ?? [], mediaIds: campaign.mediaIds ?? [], intents: campaign.intents ?? [], priority: campaign.priority ?? 0 } }]
      : [];
  });
  shadowCache.set(instagramId, { pairs, expires: Date.now() + SHADOW_TTL_MS });
  return pairs;
}

/** The old engine's decision, exactly as processComment makes it (post scope + keyword). */
export function legacyWouldMatch(a: ShadowPair["automation"], input: { mediaId: string | null; originalMediaId?: string | null; text: string }): boolean {
  const onPost = a.matchAnyPost || (a.postId !== null && (a.postId === input.mediaId || a.postId === input.originalMediaId));
  if (!onPost) return false;
  return a.matchAnyWord || matchKeywords(input.text, a.keywords, a.wholeWordMatch).matched;
}

export function copyWouldMatch(c: ShadowPair["campaign"], input: { mediaId: string | null; originalMediaId?: string | null; text: string }): boolean {
  const selection = selectCommentCampaign([{ ...c, active: true, triggerType: "COMMENT" }], { mediaId: input.mediaId, altMediaId: input.originalMediaId ?? null, text: input.text });
  return selection.campaign !== null;
}

/**
 * Called by the production comment worker for every comment. Never throws and
 * never changes what is sent: it only writes one comparison row per shadow
 * migration of the account.
 */
export async function recordShadowSamples(input: { instagramId: string; commentId: string; text: string; mediaId: string | null; originalMediaId?: string | null }): Promise<void> {
  try {
    const pairs = await loadShadowPairs(input.instagramId);
    if (pairs.length === 0) return;
    const rows: Prisma.LegacyMigrationSampleCreateManyInput[] = pairs.map((p) => ({
      migrationId: p.migrationId,
      commentId: input.commentId,
      commentText: input.text.slice(0, 500),
      mediaId: input.mediaId,
      legacyMatched: legacyWouldMatch(p.automation, input),
      newMatched: copyWouldMatch(p.campaign, input),
    }));
    await prisma.legacyMigrationSample.createMany({ data: rows, skipDuplicates: true });
  } catch (error) {
    console.error("[legacy-migration] shadow sample failed:", error instanceof Error ? error.message : error);
  }
}

/** Tests only. */
export function resetShadowCacheForTests() {
  shadowCache.clear();
}
