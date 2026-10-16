/**
 * Comment Automation 2.0 — data access for the dev UI / API: campaigns with
 * queue stats, reply variants, quick replies, follow-up steps, logs,
 * backtrack and the dry-run simulator.
 *
 * Every query is scoped to one workspace and to the comment trigger types
 * (`COMMENT`, and since ETAP 3 `LIVE_COMMENT`), so a Story Reply or Direct
 * campaign can never be read or changed through these routes (and the other
 * services skip comment campaigns the same way, see service.ts and
 * dm-trigger-service.ts).
 *
 * Live comments (TZ 17) are configured like post comments, minus what Meta
 * does not allow under a live broadcast: no public reply, no post picker and
 * no backtrack — the private reply is only possible while the live runs.
 *
 * Validation and the child-list writers are shared with the DM triggers in
 * campaign-editing.ts; they are re-exported here so existing imports keep
 * working.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { getUserMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { expireStaleBacktrackRuns, startBacktrack } from "./backtrack";
import {
  ACCOUNT_NOT_FOUND,
  accountInWorkspace,
  approveVariantIn,
  cancelExecutionFollowUpsIn,
  cleanCommentKeywords,
  done,
  executionStats,
  fail,
  intentKeys,
  listExecutionLogs,
  NOT_FOUND,
  optionalText,
  typeWhere,
  writeFollowUpSteps,
  writeQuickReplies,
  writeVariants,
  type FollowUpStepsInput,
  type LogQuery,
  type QuickRepliesInput,
  type ServiceResult,
  type VariantInput,
} from "./campaign-editing";
import { simulateComment } from "./comment-handler";
import {
  buttonTemplateTooLong,
  COMMENT_LIMITS as L,
  MATCHING_MODES,
  privateReplyLimit,
  REPLY_MODES,
} from "./comment-limits";
import { forgetAccountGate } from "./ingest";

export {
  cleanCommentKeywords,
  firstIssue,
  followUpsInputSchema,
  intentKeys,
  NOT_FOUND,
  planVariantSave,
  quickRepliesInputSchema,
  variantsInputSchema,
  type ExistingVariant,
  type ServiceResult,
  type VariantInput,
  type VariantRow,
} from "./campaign-editing";

// ─── Validation ───────────────────────────────────────────────────────────────

/** Post comments, or comments under a live broadcast (ETAP 3, TZ 17). */
export const COMMENT_TRIGGER_TYPES = ["COMMENT", "LIVE_COMMENT"] as const;
export type CommentTriggerType = (typeof COMMENT_TRIGGER_TYPES)[number];

export const LIVE_NO_PUBLIC_REPLY =
  "Live efir kommentiga ochiq javob yozib bo'lmaydi — Meta live uchun faqat shaxsiy (Direct) javobga ruxsat beradi. Ochiq javobni o'chiring.";
export const LIVE_NO_SPECIFIC_MEDIA =
  "Live efir uchun post tanlanmaydi — kampaniya akkauntning har qanday efiridagi kommentlarga javob beradi. \"Har qanday post\" ni belgilang.";
export const LIVE_NO_BACKTRACK =
  "Live efir kommentlari uchun eski kommentlarni skanerlash yo'q: efir tugagach Meta shaxsiy javob yuborishga ruxsat bermaydi.";
export const LIVE_NO_PUBLIC_VARIANTS =
  "Live efir kampaniyasida ochiq javob varianti bo'lmaydi — faqat DM variantlarini saqlang.";

export const commentCampaignSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Kampaniya nomini kiriting")
      .max(L.nameLength, `Nom ${L.nameLength} belgidan oshmasin`),
    instagramAccountId: z.string().min(1, "Instagram akkauntni tanlang"),
    triggerType: z.enum(COMMENT_TRIGGER_TYPES).default("COMMENT"),
    mediaScope: z.enum(["ANY", "SPECIFIC"]).default("ANY"),
    mediaIds: z
      .array(z.string().trim().min(1).max(64))
      .max(L.mediaIds, `Ko'pi bilan ${L.mediaIds} ta post tanlash mumkin`)
      .default([]),
    matchingMode: z.enum(MATCHING_MODES).default("CONTAINS"),
    keywords: z
      .array(z.string().max(L.keywordLength, `Kalit so'z ${L.keywordLength} belgidan oshmasin`))
      .max(L.keywords, `Ko'pi bilan ${L.keywords} ta kalit so'z`)
      .default([]),
    intents: z.array(z.string().max(40)).max(30).default([]),
    priority: z
      .number()
      .int("Prioritet butun son bo'lsin")
      .min(L.priorityMin, `Prioritet ${L.priorityMin}…${L.priorityMax} oralig'ida bo'lsin`)
      .max(L.priorityMax, `Prioritet ${L.priorityMin}…${L.priorityMax} oralig'ida bo'lsin`)
      .default(0),
    replyMode: z.enum(REPLY_MODES).default("RANDOM"),
    publicReplyEnabled: z.boolean().default(false),
    openingButtonLabel: optionalText(
      L.buttonLabelLength,
      `Tugma nomi ${L.buttonLabelLength} belgidan oshmasin (Meta cheklovi)`
    ),
    mainMessage: optionalText(L.messageLength, `Asosiy xabar ${L.messageLength} belgidan oshmasin`),
    stopOnReply: z.boolean().default(true),
    stopOnLead: z.boolean().default(true),
    stopOnHandoff: z.boolean().default(true),
    stopOnPurchase: z.boolean().default(true),
    responseMessage: z
      .string()
      .trim()
      .min(1, "Zaxira DM matnini kiriting — tasdiqlangan variant bo'lmasa shu yuboriladi")
      .max(L.messageLength, `DM matni ${L.messageLength} belgidan oshmasin (Meta cheklovi)`),
    active: z.boolean().default(true),
  })
  .transform((input) => ({
    ...input,
    keywords: input.matchingMode === "EVERY" ? [] : cleanCommentKeywords(input.keywords),
    intents: input.matchingMode === "EVERY" ? [] : [...new Set(input.intents)],
    mediaIds: input.mediaScope === "ANY" ? [] : [...new Set(input.mediaIds)],
  }))
  .superRefine((input, ctx) => {
    if (input.matchingMode !== "EVERY" && input.keywords.length === 0 && input.intents.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["keywords"],
        message: "Kamida bitta kalit so'z yoki intent tanlang (yoki \"Har bir komment\" rejimini yoqing)",
      });
    }
    const known = new Set(intentKeys());
    const unknown = input.intents.find((key) => !known.has(key));
    if (unknown) {
      ctx.addIssue({ code: "custom", path: ["intents"], message: `Noma'lum intent: ${unknown}` });
    }
    if (input.triggerType === "LIVE_COMMENT") {
      // Meta: a live comment gets one private reply, only while the broadcast
      // runs. No public reply, and live videos are not picked like posts.
      if (input.publicReplyEnabled) {
        ctx.addIssue({ code: "custom", path: ["publicReplyEnabled"], message: LIVE_NO_PUBLIC_REPLY });
      }
      if (input.mediaScope === "SPECIFIC") {
        ctx.addIssue({ code: "custom", path: ["mediaScope"], message: LIVE_NO_SPECIFIC_MEDIA });
      }
    } else if (input.mediaScope === "SPECIFIC" && input.mediaIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mediaIds"],
        message: "Kamida bitta post tanlang yoki \"Har qanday post\" ni belgilang",
      });
    }
    if (input.mainMessage && !input.openingButtonLabel) {
      ctx.addIssue({
        code: "custom",
        path: ["openingButtonLabel"],
        message:
          "Asosiy xabar faqat odam tugmani bosgandan keyin yuboriladi (Meta qoidasi) — tugma nomini kiriting",
      });
    }
    if (input.openingButtonLabel && !input.mainMessage) {
      ctx.addIssue({
        code: "custom",
        path: ["mainMessage"],
        message: "Tugma bosilganda yuboriladigan asosiy xabarni kiriting",
      });
    }
    // With the button the private reply is a button template: 640, not 1000.
    if (input.openingButtonLabel && input.responseMessage.length > privateReplyLimit(true)) {
      ctx.addIssue({ code: "custom", path: ["responseMessage"], message: buttonTemplateTooLong("Zaxira DM matni") });
    }
  });

export type CommentCampaignInput = z.infer<typeof commentCampaignSchema>;

export const toggleSchema = z.object({ active: z.boolean() }).strict();

export const backtrackInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1, "Kamida 1 kun")
    .max(L.backtrackMaxDays, `Ko'pi bilan ${L.backtrackMaxDays} kun — Meta 7 kundan eski kommentga yozishga ruxsat bermaydi`),
});

export const simulateInputSchema = z.object({
  instagramAccountId: z.string().min(1, "Akkauntni tanlang"),
  mediaId: z.string().trim().max(64).nullish().transform((v) => v || null),
  text: z.string().trim().min(1, "Komment matnini kiriting").max(2000),
  eventType: z.enum(COMMENT_TRIGGER_TYPES).default("COMMENT"),
  /** The campaign being edited — tested even while it is off (draft / paused). */
  campaignId: z.string().trim().max(64).nullish().transform((v) => v || null),
});

// ─── Scoping helpers ──────────────────────────────────────────────────────────

const COMMENT_TYPES = typeWhere(COMMENT_TRIGGER_TYPES);

// A published flow's hidden proxy row (kind FLOW, ETAP 6) is never listed or editable here (see isProxy).
const isProxy = (row: { kind?: string | null } | null | undefined) => row?.kind === "FLOW";

function campaignWhere(workspaceId: string, id: string): Prisma.TriggerCampaignWhereInput {
  return { id, workspaceId, triggerType: COMMENT_TYPES };
}

async function findCampaign(workspaceId: string, id: string) {
  const row = await prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    select: {
      id: true,
      kind: true,
      triggerType: true,
      openingButtonLabel: true,
      instagramAccount: { select: { instagramId: true } },
      _count: { select: { quickReplies: true, followUpSteps: true } },
    },
  });
  return isProxy(row) ? null : row;
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

/** Comment campaigns (post and live) with what the TZ calls "queue visibility": where every comment is right now. */
export async function listCommentCampaigns(workspaceId: string, options: { active?: boolean; take?: number } = {}) {
  const found = await prisma.triggerCampaign.findMany({
    where: { workspaceId, triggerType: COMMENT_TYPES, kind: { not: "FLOW" }, ...(options.active === undefined ? {} : { active: options.active }) },
    orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    ...(options.take ? { take: options.take } : {}),
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { select: { kind: true, approvedAt: true } },
      _count: { select: { quickReplies: true, followUpSteps: true } },
    },
  });
  const campaigns = found.filter((c) => !isProxy(c));
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.id);

  const [stats, byPublic, lastRuns] = await Promise.all([
    executionStats(workspaceId, ids),
    prisma.triggerExecution.groupBy({
      by: ["campaignId", "publicReplyStatus"],
      where: { workspaceId, campaignId: { in: ids }, publicReplyStatus: { not: null } },
      _count: { _all: true },
    }),
    prisma.triggerBacktrackRun.findMany({
      where: { workspaceId, campaignId: { in: ids } },
      orderBy: { startedAt: "desc" },
      distinct: ["campaignId"],
    }),
  ]);

  const publicReplies = new Map<string, Record<string, number>>();
  for (const row of byPublic) {
    const entry = publicReplies.get(row.campaignId) ?? {};
    const key = row.publicReplyStatus ?? "";
    entry[key] = (entry[key] ?? 0) + row._count._all;
    publicReplies.set(row.campaignId, entry);
  }
  const lastRun = new Map(lastRuns.map((run) => [run.campaignId, run]));

  return campaigns.map(({ replyVariants, ...campaign }) => {
    const s = stats.get(campaign.id)!;
    const p = publicReplies.get(campaign.id) ?? {};
    return {
      ...campaign,
      variants: {
        dmApproved: replyVariants.filter((v) => v.kind === "DM" && v.approvedAt).length,
        publicApproved: replyVariants.filter((v) => v.kind === "PUBLIC" && v.approvedAt).length,
        unapproved: replyVariants.filter((v) => !v.approvedAt).length,
      },
      stats: {
        executions: s.executions,
        publicSent: p.SENT ?? 0,
        publicFailed: p.FAILED ?? 0,
        opened: s.opened,
        leads: s.leads,
        handoffs: s.handoffs,
        followUps: s.followUps,
      },
      lastBacktrack: lastRun.get(campaign.id) ?? null,
    };
  });
}

export interface LegacyAutomationRow {
  id: string;
  name: string;
  isActive: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  postId: string | null;
  matchAnyPost: boolean;
  instagramAccount: { username: string };
  stats: { total: number; sent: number; failed: number; skipped: number };
  /** Marks the row as the production (old) engine: shown read-only, never edited or imported here. */
  source: "production_legacy";
}

/**
 * B-34: the production comment→DM campaigns (the legacy `Automation` model,
 * answered by lib/queue/dm-worker.ts) listed read-only next to Comment 2.0, so
 * a live "Salom" campaign is not invisible here. Nothing is imported or
 * copied: two engines answering one comment would double-send, so these rows
 * only show what already runs. Counts come from the same DmLog the dashboard
 * and the analytics rollups read.
 */
export async function listLegacyAutomations(workspaceId: string): Promise<LegacyAutomationRow[]> {
  const automations = await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      name: true,
      isActive: true,
      keywords: true,
      matchAnyWord: true,
      postId: true,
      matchAnyPost: true,
      instagramAccount: { select: { username: true } },
    },
  });
  if (automations.length === 0) return [];
  const logs = await prisma.dmLog.groupBy({
    by: ["automationId", "status"],
    where: { workspaceId, automationId: { in: automations.map((a) => a.id) } },
    _count: { _all: true },
  });
  return automations.map((a) => {
    const rows = logs.filter((l) => l.automationId === a.id);
    const count = (pick: (status: string) => boolean) =>
      rows.filter((r) => pick(r.status)).reduce((sum, r) => sum + r._count._all, 0);
    return {
      ...a,
      stats: {
        total: count(() => true),
        sent: count((s) => s === "SENT"),
        failed: count((s) => s === "FAILED"),
        skipped: count((s) => s.startsWith("SKIPPED_")),
      },
      source: "production_legacy" as const,
    };
  });
}

/** How many comment campaigns match (same filter as listCommentCampaigns), for a total next to a limited list. */
export async function countCommentCampaigns(workspaceId: string, options: { active?: boolean } = {}) {
  return prisma.triggerCampaign.count({
    where: { workspaceId, triggerType: COMMENT_TYPES, kind: { not: "FLOW" }, ...(options.active === undefined ? {} : { active: options.active }) },
  });
}

export async function getCommentCampaign(workspaceId: string, id: string) {
  const row = await prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { orderBy: [{ kind: "asc" }, { sort: "asc" }] },
      quickReplies: { orderBy: { sort: "asc" } },
      followUpSteps: { orderBy: { sort: "asc" } },
      backtrackRuns: { orderBy: { startedAt: "desc" }, take: 10 },
    },
  });
  return isProxy(row) ? null : row;
}

export async function createCommentCampaign(
  workspaceId: string,
  input: CommentCampaignInput
): Promise<ServiceResult<{ id: string }>> {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(400, ACCOUNT_NOT_FOUND);
  const campaign = await prisma.triggerCampaign.create({
    data: { ...input, workspaceId, responseType: "SEND_MESSAGE" },
    select: { id: true },
  });
  forgetAccountGate(account.instagramId);
  return done(campaign);
}

export async function updateCommentCampaign(
  workspaceId: string,
  id: string,
  input: CommentCampaignInput
): Promise<ServiceResult<{ id: string }>> {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return fail(404, NOT_FOUND);
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(400, ACCOUNT_NOT_FOUND);
  if (input.triggerType === "LIVE_COMMENT") {
    // Switching a post campaign to live: the builder drops the public
    // variants first; anything left would be a public reply under a live.
    const publicVariants = await prisma.triggerReplyVariant.count({ where: { campaignId: id, kind: "PUBLIC" } });
    if (publicVariants > 0) return fail(422, LIVE_NO_PUBLIC_VARIANTS);
  }
  if (input.openingButtonLabel) {
    // DM variants are saved through their own endpoint; the builder saves them
    // before this call whenever the button is on, so these are the new ones.
    const dmVariants = await prisma.triggerReplyVariant.findMany({
      where: { campaignId: id, kind: "DM" },
      select: { text: true },
    });
    if (dmVariants.some((v) => v.text.length > privateReplyLimit(true))) {
      return fail(422, buttonTemplateTooLong("Tugma qo'shilsa, har bir DM varianti"));
    }
  }

  const update = prisma.triggerCampaign.update({ where: { id }, data: input });
  if (!input.openingButtonLabel && (existing._count.quickReplies > 0 || existing._count.followUpSteps > 0)) {
    // Quick replies and follow-ups only work after the button is tapped:
    // without the button they go too, in the same transaction as the campaign
    // (a failed save leaves both as they were). Removing a step also removes
    // its runs (cascade); the scheduled ones are cancelled first for the record.
    await prisma.$transaction([
      update,
      prisma.triggerFollowUpRun.updateMany({
        where: { step: { campaignId: id }, status: "SCHEDULED" },
        data: { status: "CANCELLED", reason: "Tugma olib tashlandi" },
      }),
      prisma.triggerQuickReply.deleteMany({ where: { campaignId: id } }),
      prisma.triggerFollowUpStep.deleteMany({ where: { campaignId: id } }),
    ]);
  } else {
    await update;
  }
  forgetAccountGate(existing.instagramAccount.instagramId);
  forgetAccountGate(account.instagramId);
  return done({ id });
}

export async function setCommentCampaignActive(workspaceId: string, id: string, active: boolean) {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return false;
  await prisma.triggerCampaign.update({ where: { id }, data: { active } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  return true;
}

export async function deleteCommentCampaign(workspaceId: string, id: string) {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return false;
  await prisma.triggerCampaign.delete({ where: { id } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  return true;
}

// ─── Variants, quick replies, follow-ups ──────────────────────────────────────

export async function saveVariants(workspaceId: string, campaignId: string, input: VariantInput[]) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (campaign.triggerType === "LIVE_COMMENT" && input.some((v) => v.kind === "PUBLIC")) {
    return fail(422, LIVE_NO_PUBLIC_VARIANTS);
  }
  if (
    campaign.openingButtonLabel &&
    input.some((v) => v.kind === "DM" && v.text.length > privateReplyLimit(true))
  ) {
    return fail(422, buttonTemplateTooLong("Tugmali kampaniyada har bir DM varianti"));
  }
  return done(await writeVariants(campaignId, input));
}

export async function setVariantApproved(workspaceId: string, variantId: string, approved: boolean) {
  return approveVariantIn(workspaceId, variantId, approved, COMMENT_TRIGGER_TYPES);
}

const NEEDS_BUTTON =
  "Avval \"Tugma & asosiy xabar\" bo'limida tugma nomini saqlang: Meta odam javob bermaguncha (tugmani bosmaguncha) ikkinchi xabar yuborishga ruxsat bermaydi.";

export async function saveQuickReplies(workspaceId: string, campaignId: string, input: QuickRepliesInput) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.length > 0 && !campaign.openingButtonLabel) return fail(422, NEEDS_BUTTON);
  return done(await writeQuickReplies(campaignId, input));
}

export async function saveFollowUpSteps(workspaceId: string, campaignId: string, input: FollowUpStepsInput) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.length > 0 && !campaign.openingButtonLabel) return fail(422, NEEDS_BUTTON);
  return done(await writeFollowUpSteps(campaignId, input));
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function listCampaignLogs(workspaceId: string, campaignId: string, query: LogQuery) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  return listExecutionLogs(workspaceId, campaignId, query);
}

export async function cancelExecutionFollowUps(workspaceId: string, executionId: string) {
  return cancelExecutionFollowUpsIn(workspaceId, executionId, COMMENT_TRIGGER_TYPES);
}

// ─── Backtrack ────────────────────────────────────────────────────────────────

export async function startCampaignBacktrack(workspaceId: string, campaignId: string, days: number) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (campaign.triggerType === "LIVE_COMMENT") return fail(422, LIVE_NO_BACKTRACK);
  try {
    return done(await startBacktrack(workspaceId, campaignId, days));
  } catch (error) {
    // The engine throws Uzbek messages for rule violations (inactive, already
    // running…); "already running" carries status 409.
    const status = (error as { status?: unknown } | null)?.status === 409 ? 409 : 422;
    return fail(status, error instanceof Error && error.message ? error.message : "Backtrackni boshlab bo'lmadi");
  }
}

export async function listBacktrackRuns(workspaceId: string, campaignId: string) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  // A run left RUNNING by a restarted server would otherwise spin in the UI forever.
  await expireStaleBacktrackRuns(campaignId);
  return prisma.triggerBacktrackRun.findMany({
    where: { workspaceId, campaignId },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
}

// ─── Simulator / media ────────────────────────────────────────────────────────

export async function simulateCommentDryRun(workspaceId: string, input: z.infer<typeof simulateInputSchema>) {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(404, "Instagram akkaunt topilmadi");
  return done(
    await simulateComment(workspaceId, {
      instagramAccountId: account.id,
      // A live comment carries the live video's id, never a picked post.
      mediaId: input.eventType === "LIVE_COMMENT" ? null : input.mediaId,
      text: input.text,
      eventType: input.eventType,
      includeCampaignId: input.campaignId,
    })
  );
}

export interface MediaItem {
  id: string;
  caption: string | null;
  mediaType: string | null;
  previewUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  commentsCount: number | null;
}

/**
 * Recent posts for the picker: live from Instagram (same call the production
 * post picker uses), plus posts people have commented on as a fallback when
 * the Graph call fails. Errors come back as text, not a throw.
 */
export async function listRecentMedia(workspaceId: string, accountId: string) {
  const account = await accountInWorkspace(workspaceId, accountId);
  if (!account) return null;

  let posts: MediaItem[] = [];
  let error: string | null = null;
  try {
    const media = await getUserMedia(decryptToken(account.accessToken), 30);
    posts = media.map((m) => ({
      id: m.id,
      caption: m.caption?.slice(0, 200) ?? null,
      mediaType: m.media_type ?? null,
      previewUrl: m.thumbnail_url ?? m.media_url ?? null,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? null,
      commentsCount: m.comments_count ?? null,
    }));
  } catch (err) {
    error = err instanceof Error ? err.message : "Instagram javob bermadi";
  }

  const rows = await prisma.instagramEvent.findMany({
    where: { workspaceId, instagramAccountId: account.id, eventType: "COMMENT", mediaId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { mediaId: true, createdAt: true },
  });
  const commented = new Map<string, { mediaId: string; comments: number; lastCommentAt: Date }>();
  for (const row of rows) {
    if (!row.mediaId) continue;
    const entry = commented.get(row.mediaId);
    if (entry) entry.comments++;
    else commented.set(row.mediaId, { mediaId: row.mediaId, comments: 1, lastCommentAt: row.createdAt });
  }
  return { posts, error, commented: [...commented.values()].slice(0, 30) };
}

/** Accounts for the builder's picker. */
export async function listWorkspaceAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, tokenStatus: true },
  });
}
