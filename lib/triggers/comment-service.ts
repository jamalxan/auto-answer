/**
 * Comment Automation 2.0 — data access for the dev UI / API: campaigns with
 * queue stats, reply variants, quick replies, follow-up steps, logs,
 * backtrack and the dry-run simulator.
 *
 * Every query is scoped to one workspace and to `triggerType: COMMENT`, so a
 * Story Reply campaign can never be read or changed through these routes (and
 * the Story routes skip COMMENT campaigns the same way, see service.ts).
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { getUserMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { expireStaleBacktrackRuns, startBacktrack } from "./backtrack";
import { simulateComment } from "./comment-handler";
import {
  buttonTemplateTooLong,
  COMMENT_LIMITS as L,
  EXECUTION_STATUSES,
  FOLLOW_UP_CONDITIONS,
  MATCHING_MODES,
  privateReplyLimit,
  QUICK_REPLY_ACTIONS,
  REPLY_MODES,
} from "./comment-limits";
import { cancelFollowUps } from "./followups";
import { forgetAccountGate } from "./ingest";
import { BUILT_IN_INTENTS, normalizeForMatch } from "./keywords";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const done = <T>(data: T) => ({ ok: true as const, data });

export const NOT_FOUND = "Kampaniya topilmadi";

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Trimmed text, or null when empty. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((value) => (value ? value : null));

/** Keeps the keyword as typed; drops empties and normalised duplicates (narx / NARX / нарх). */
export function cleanCommentKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of raw) {
    const trimmed = keyword.trim();
    const key = normalizeForMatch(trimmed);
    if (!trimmed || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function intentKeys(): string[] {
  return BUILT_IN_INTENTS.map((intent) => intent.key);
}

export const commentCampaignSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Kampaniya nomini kiriting")
      .max(L.nameLength, `Nom ${L.nameLength} belgidan oshmasin`),
    instagramAccountId: z.string().min(1, "Instagram akkauntni tanlang"),
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
    if (input.mediaScope === "SPECIFIC" && input.mediaIds.length === 0) {
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

const variantSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    kind: z.enum(["DM", "PUBLIC"]),
    text: z.string().trim().min(1, "Bo'sh variant qoldirmang"),
    weight: z
      .number()
      .int()
      .min(L.weightMin, `Vazn ${L.weightMin}…${L.weightMax} oralig'ida bo'lsin`)
      .max(L.weightMax, `Vazn ${L.weightMin}…${L.weightMax} oralig'ida bo'lsin`)
      .default(1),
    source: z.enum(["MANUAL", "AI"]).default("MANUAL"),
    approved: z.boolean().optional(),
  })
  .superRefine((variant, ctx) => {
    const max = variant.kind === "DM" ? L.messageLength : L.publicReplyLength;
    if (variant.text.length > max) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message:
          variant.kind === "DM"
            ? `DM varianti ${max} belgidan oshmasin (Meta cheklovi)`
            : `Ochiq javob varianti ${max} belgidan oshmasin`,
      });
    }
  });

export const variantsInputSchema = z
  .object({ variants: z.array(variantSchema).max(L.variantsPerKind * 2) })
  .superRefine((input, ctx) => {
    for (const kind of ["DM", "PUBLIC"] as const) {
      const texts = input.variants.filter((v) => v.kind === kind).map((v) => v.text.toLowerCase());
      if (texts.length > L.variantsPerKind) {
        ctx.addIssue({
          code: "custom",
          path: ["variants"],
          message: `${kind === "DM" ? "DM" : "Ochiq javob"} variantlari ko'pi bilan ${L.variantsPerKind} ta`,
        });
      }
      if (new Set(texts).size !== texts.length) {
        ctx.addIssue({ code: "custom", path: ["variants"], message: "Bir xil variant ikki marta yozilgan" });
      }
    }
  });

export type VariantInput = z.infer<typeof variantsInputSchema>["variants"][number];

export const quickRepliesInputSchema = z
  .object({
    quickReplies: z
      .array(
        z.object({
          id: z.string().min(1).max(64).optional(),
          label: z
            .string()
            .trim()
            .min(1, "Tugma nomini kiriting")
            .max(L.quickReplyLabelLength, `Tugma nomi ${L.quickReplyLabelLength} belgidan oshmasin (Meta cheklovi)`),
          action: z.enum(QUICK_REPLY_ACTIONS),
          responseText: optionalText(L.messageLength, `Javob ${L.messageLength} belgidan oshmasin`),
        })
      )
      .max(L.quickReplies, `Ko'pi bilan ${L.quickReplies} ta quick reply (Meta cheklovi)`),
  })
  .superRefine((input, ctx) => {
    input.quickReplies.forEach((reply, index) => {
      if (reply.action === "MESSAGE" && !reply.responseText) {
        ctx.addIssue({
          code: "custom",
          path: ["quickReplies", index, "responseText"],
          message: `"${reply.label}" tugmasi bosilganda yuboriladigan matnni kiriting`,
        });
      }
    });
    const labels = input.quickReplies.map((r) => r.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", path: ["quickReplies"], message: "Tugma nomlari takrorlanmasin" });
    }
  });

export const followUpsInputSchema = z
  .object({
    steps: z
      .array(
        z.object({
          id: z.string().min(1).max(64).optional(),
          delayMinutes: z
            .number()
            .int("Kechikish butun daqiqa bo'lsin")
            .min(1, "Kechikish kamida 1 daqiqa")
            .max(
              L.followUpMaxDelayMinutes,
              `Kechikish ko'pi bilan ${L.followUpMaxDelayMinutes} daqiqa (23 soat) — Meta'ning 24 soatlik oynasi yopilmasdan yuborilishi kerak`
            ),
          condition: z.enum(FOLLOW_UP_CONDITIONS).default("ALWAYS"),
          message: z
            .string()
            .trim()
            .min(1, "Follow-up matnini kiriting")
            .max(L.messageLength, `Follow-up ${L.messageLength} belgidan oshmasin`),
        })
      )
      .max(L.followUpSteps, `Ko'pi bilan ${L.followUpSteps} ta follow-up`),
  })
  .superRefine((input, ctx) => {
    for (let i = 1; i < input.steps.length; i++) {
      if (input.steps[i].delayMinutes <= input.steps[i - 1].delayMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "delayMinutes"],
          message: `${i + 1}-follow-up ${i}-sidan keyinroq bo'lsin (kechikishlar o'sib borsin)`,
        });
      }
    }
  });

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
});

// ─── Variant save plan (pure) ─────────────────────────────────────────────────

export interface ExistingVariant {
  id: string;
  kind: "DM" | "PUBLIC";
  text: string;
  source: "MANUAL" | "AI";
  approvedAt: Date | null;
}

export interface VariantRow {
  kind: "DM" | "PUBLIC";
  text: string;
  weight: number;
  sort: number;
  source: "MANUAL" | "AI";
  approvedAt: Date | null;
}

/**
 * Replace-all save, worked out without touching the database:
 *  - a variant keeps its id (and so its log history) when the id is sent back;
 *  - MANUAL text is approved on save — the person just typed it;
 *  - AI text is approved only when `approved` is sent, or it was approved
 *    before and its text has not changed. Edited AI text needs a new approval.
 */
export function planVariantSave(existing: ExistingVariant[], input: VariantInput[], now = new Date()) {
  const byId = new Map(existing.map((v) => [v.id, v]));
  const sorts = { DM: 0, PUBLIC: 0 };
  const updates: Array<{ id: string; data: VariantRow }> = [];
  const creates: VariantRow[] = [];

  for (const variant of input) {
    const before = variant.id ? byId.get(variant.id) : undefined;
    const source = before?.source ?? variant.source;
    const unchanged = Boolean(before && before.text === variant.text && before.kind === variant.kind);
    let approvedAt: Date | null;
    if (variant.approved === false) approvedAt = null;
    else if (source === "MANUAL") approvedAt = unchanged ? (before!.approvedAt ?? now) : now;
    else if (variant.approved === true) approvedAt = unchanged ? (before!.approvedAt ?? now) : now;
    else approvedAt = unchanged ? before!.approvedAt : null;

    const row: VariantRow = {
      kind: variant.kind,
      text: variant.text,
      weight: variant.weight,
      sort: sorts[variant.kind]++,
      source,
      approvedAt,
    };
    if (before) {
      updates.push({ id: before.id, data: row });
      byId.delete(before.id);
    } else {
      creates.push(row);
    }
  }
  return { updates, creates, deleteIds: [...byId.keys()] };
}

// ─── Scoping helpers ──────────────────────────────────────────────────────────

async function accountInWorkspace(workspaceId: string, accountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true, instagramId: true, username: true, accessToken: true },
  });
}

function campaignWhere(workspaceId: string, id: string): Prisma.TriggerCampaignWhereInput {
  return { id, workspaceId, triggerType: "COMMENT" };
}

async function findCampaign(workspaceId: string, id: string) {
  return prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    select: {
      id: true,
      openingButtonLabel: true,
      instagramAccount: { select: { instagramId: true } },
      _count: { select: { quickReplies: true, followUpSteps: true } },
    },
  });
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

type Counts = Record<string, number>;

function bump(map: Map<string, Counts>, campaignId: string, key: string, count: number) {
  const entry = map.get(campaignId) ?? {};
  entry[key] = (entry[key] ?? 0) + count;
  map.set(campaignId, entry);
}

/** COMMENT campaigns with what the TZ calls "queue visibility": where every comment is right now. */
export async function listCommentCampaigns(workspaceId: string) {
  const campaigns = await prisma.triggerCampaign.findMany({
    where: { workspaceId, triggerType: "COMMENT" },
    orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { select: { kind: true, approvedAt: true } },
      _count: { select: { quickReplies: true, followUpSteps: true } },
    },
  });
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.id);

  const [byStatus, byPublic, opened, leads, handoffs, steps, followUps, lastRuns] = await Promise.all([
    prisma.triggerExecution.groupBy({
      by: ["campaignId", "status"],
      where: { workspaceId, campaignId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.triggerExecution.groupBy({
      by: ["campaignId", "publicReplyStatus"],
      where: { workspaceId, campaignId: { in: ids }, publicReplyStatus: { not: null } },
      _count: { _all: true },
    }),
    prisma.triggerExecution.groupBy({
      by: ["campaignId"],
      where: { workspaceId, campaignId: { in: ids }, openedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.triggerExecution.groupBy({
      by: ["campaignId"],
      where: { workspaceId, campaignId: { in: ids }, leadCapturedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.triggerExecution.groupBy({
      by: ["campaignId"],
      where: { workspaceId, campaignId: { in: ids }, handedOffAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.triggerFollowUpStep.findMany({ where: { campaignId: { in: ids } }, select: { id: true, campaignId: true } }),
    prisma.triggerFollowUpRun.groupBy({
      by: ["stepId", "status"],
      where: { workspaceId, step: { campaignId: { in: ids } } },
      _count: { _all: true },
    }),
    prisma.triggerBacktrackRun.findMany({
      where: { workspaceId, campaignId: { in: ids } },
      orderBy: { startedAt: "desc" },
      distinct: ["campaignId"],
    }),
  ]);

  const executions = new Map<string, Counts>();
  for (const row of byStatus) bump(executions, row.campaignId, row.status, row._count._all);
  const publicReplies = new Map<string, Counts>();
  for (const row of byPublic) bump(publicReplies, row.campaignId, row.publicReplyStatus ?? "", row._count._all);
  const flags = new Map<string, Counts>();
  for (const row of opened) bump(flags, row.campaignId, "opened", row._count._all);
  for (const row of leads) bump(flags, row.campaignId, "leads", row._count._all);
  for (const row of handoffs) bump(flags, row.campaignId, "handoffs", row._count._all);
  const stepCampaign = new Map(steps.map((s) => [s.id, s.campaignId]));
  const followUpCounts = new Map<string, Counts>();
  for (const row of followUps) {
    const campaignId = stepCampaign.get(row.stepId);
    if (campaignId) bump(followUpCounts, campaignId, row.status, row._count._all);
  }
  const lastRun = new Map(lastRuns.map((run) => [run.campaignId, run]));

  return campaigns.map(({ replyVariants, ...campaign }) => {
    const e = executions.get(campaign.id) ?? {};
    const p = publicReplies.get(campaign.id) ?? {};
    const f = flags.get(campaign.id) ?? {};
    return {
      ...campaign,
      variants: {
        dmApproved: replyVariants.filter((v) => v.kind === "DM" && v.approvedAt).length,
        publicApproved: replyVariants.filter((v) => v.kind === "PUBLIC" && v.approvedAt).length,
        unapproved: replyVariants.filter((v) => !v.approvedAt).length,
      },
      stats: {
        executions: Object.fromEntries(EXECUTION_STATUSES.map((s) => [s, e[s] ?? 0])) as Record<
          (typeof EXECUTION_STATUSES)[number],
          number
        >,
        publicSent: p.SENT ?? 0,
        publicFailed: p.FAILED ?? 0,
        opened: f.opened ?? 0,
        leads: f.leads ?? 0,
        handoffs: f.handoffs ?? 0,
        followUps: followUpCounts.get(campaign.id) ?? {},
      },
      lastBacktrack: lastRun.get(campaign.id) ?? null,
    };
  });
}

export async function getCommentCampaign(workspaceId: string, id: string) {
  return prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { orderBy: [{ kind: "asc" }, { sort: "asc" }] },
      quickReplies: { orderBy: { sort: "asc" } },
      followUpSteps: { orderBy: { sort: "asc" } },
      backtrackRuns: { orderBy: { startedAt: "desc" }, take: 10 },
    },
  });
}

export async function createCommentCampaign(
  workspaceId: string,
  input: CommentCampaignInput
): Promise<ServiceResult<{ id: string }>> {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(400, "Instagram akkaunt topilmadi — u boshqa workspace'ga tegishli yoki uzilgan");
  const campaign = await prisma.triggerCampaign.create({
    data: { ...input, workspaceId, triggerType: "COMMENT", responseType: "SEND_MESSAGE" },
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
  if (!account) return fail(400, "Instagram akkaunt topilmadi — u boshqa workspace'ga tegishli yoki uzilgan");
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
  if (
    campaign.openingButtonLabel &&
    input.some((v) => v.kind === "DM" && v.text.length > privateReplyLimit(true))
  ) {
    return fail(422, buttonTemplateTooLong("Tugmali kampaniyada har bir DM varianti"));
  }
  const existing = await prisma.triggerReplyVariant.findMany({
    where: { campaignId },
    select: { id: true, kind: true, text: true, source: true, approvedAt: true },
  });
  const plan = planVariantSave(existing, input);
  await prisma.$transaction([
    prisma.triggerReplyVariant.deleteMany({ where: { campaignId, id: { in: plan.deleteIds } } }),
    ...plan.updates.map((u) => prisma.triggerReplyVariant.update({ where: { id: u.id }, data: u.data })),
    ...plan.creates.map((data) => prisma.triggerReplyVariant.create({ data: { ...data, campaignId } })),
  ]);
  return done(
    await prisma.triggerReplyVariant.findMany({ where: { campaignId }, orderBy: [{ kind: "asc" }, { sort: "asc" }] })
  );
}

export async function setVariantApproved(workspaceId: string, variantId: string, approved: boolean) {
  const variant = await prisma.triggerReplyVariant.findFirst({
    where: { id: variantId, campaign: { workspaceId, triggerType: "COMMENT" } },
    select: { id: true },
  });
  if (!variant) return fail(404, "Variant topilmadi");
  return done(
    await prisma.triggerReplyVariant.update({
      where: { id: variantId },
      data: { approvedAt: approved ? new Date() : null },
    })
  );
}

const NEEDS_BUTTON =
  "Avval \"Tugma & asosiy xabar\" bo'limida tugma nomini saqlang: Meta odam javob bermaguncha (tugmani bosmaguncha) ikkinchi xabar yuborishga ruxsat bermaydi.";

export async function saveQuickReplies(
  workspaceId: string,
  campaignId: string,
  input: z.infer<typeof quickRepliesInputSchema>["quickReplies"]
) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.length > 0 && !campaign.openingButtonLabel) return fail(422, NEEDS_BUTTON);

  // Ids are kept: a tap on a message sent earlier carries the old id.
  const existing = await prisma.triggerQuickReply.findMany({ where: { campaignId }, select: { id: true } });
  const known = new Set(existing.map((r) => r.id));
  const kept = input.filter((r) => r.id && known.has(r.id)).map((r) => r.id!);
  await prisma.$transaction([
    prisma.triggerQuickReply.deleteMany({ where: { campaignId, id: { notIn: kept } } }),
    ...input.map((reply, sort) => {
      const data = { label: reply.label, action: reply.action, responseText: reply.responseText, sort };
      return reply.id && known.has(reply.id)
        ? prisma.triggerQuickReply.update({ where: { id: reply.id }, data })
        : prisma.triggerQuickReply.create({ data: { ...data, campaignId } });
    }),
  ]);
  return done(await prisma.triggerQuickReply.findMany({ where: { campaignId }, orderBy: { sort: "asc" } }));
}

export async function saveFollowUpSteps(
  workspaceId: string,
  campaignId: string,
  input: z.infer<typeof followUpsInputSchema>["steps"]
) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.length > 0 && !campaign.openingButtonLabel) return fail(422, NEEDS_BUTTON);

  // Ids are kept so runs already scheduled for an unchanged step stay valid;
  // a removed step takes its scheduled runs with it (cascade).
  const existing = await prisma.triggerFollowUpStep.findMany({ where: { campaignId }, select: { id: true } });
  const known = new Set(existing.map((s) => s.id));
  const kept = input.filter((s) => s.id && known.has(s.id)).map((s) => s.id!);
  await prisma.$transaction([
    prisma.triggerFollowUpStep.deleteMany({ where: { campaignId, id: { notIn: kept } } }),
    ...input.map((step, sort) => {
      const data = { delayMinutes: step.delayMinutes, condition: step.condition, message: step.message, sort };
      return step.id && known.has(step.id)
        ? prisma.triggerFollowUpStep.update({ where: { id: step.id }, data })
        : prisma.triggerFollowUpStep.create({ data: { ...data, campaignId } });
    }),
  ]);
  return done(await prisma.triggerFollowUpStep.findMany({ where: { campaignId }, orderBy: { sort: "asc" } }));
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function listCampaignLogs(
  workspaceId: string,
  campaignId: string,
  query: { page?: number; limit?: number; status?: string | null }
) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const limit = Math.min(50, Math.max(1, Math.floor(query.limit ?? 20) || 20));
  const where: Prisma.TriggerExecutionWhereInput = { workspaceId, campaignId };
  if (query.status && (EXECUTION_STATUSES as readonly string[]).includes(query.status)) {
    where.status = query.status as (typeof EXECUTION_STATUSES)[number];
  }

  const [total, executions] = await Promise.all([
    prisma.triggerExecution.count({ where }),
    prisma.triggerExecution.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        status: true,
        matchedKeyword: true,
        responseText: true,
        error: true,
        attempts: true,
        nextRetryAt: true,
        sentAt: true,
        createdAt: true,
        publicReplyStatus: true,
        publicReplyError: true,
        openedAt: true,
        lastInboundAt: true,
        leadCapturedAt: true,
        handedOffAt: true,
        stoppedAt: true,
        stopReason: true,
        variant: { select: { id: true, kind: true, text: true, source: true } },
        event: {
          select: {
            id: true,
            text: true,
            senderId: true,
            senderUsername: true,
            mediaId: true,
            timestamp: true,
            backtrackRunId: true,
            contact: { select: { username: true, name: true, phone: true, email: true } },
          },
        },
        followUps: {
          orderBy: { scheduledAt: "asc" },
          select: {
            id: true,
            status: true,
            scheduledAt: true,
            sentAt: true,
            reason: true,
            step: { select: { sort: true, delayMinutes: true, condition: true } },
          },
        },
      },
    }),
  ]);
  return { executions, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function cancelExecutionFollowUps(workspaceId: string, executionId: string) {
  const execution = await prisma.triggerExecution.findFirst({
    where: { id: executionId, workspaceId, campaign: { triggerType: "COMMENT" } },
    select: { id: true },
  });
  if (!execution) return fail(404, "Bajarilish topilmadi");
  const cancelled = await cancelFollowUps(workspaceId, executionId, "Qo'lda bekor qilindi");
  return done({ cancelled });
}

// ─── Backtrack ────────────────────────────────────────────────────────────────

export async function startCampaignBacktrack(workspaceId: string, campaignId: string, days: number) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
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
      mediaId: input.mediaId,
      text: input.text,
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
