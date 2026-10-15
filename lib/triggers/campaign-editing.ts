/**
 * Editing pieces shared by the Comment 2.0 service (comment-service.ts) and
 * the ETAP 3 DM-trigger service (dm-trigger-service.ts): validation of reply
 * variants / quick replies / follow-up steps, the replace-all variant save
 * plan, the database writers for those child lists, and execution logs.
 *
 * Nothing here checks which campaign it is writing to: the caller looks the
 * campaign up first, scoped to its workspace and its trigger types, and only
 * then hands the id over.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { InstagramEventType, Prisma } from "@/app/generated/prisma/client";
import {
  COMMENT_LIMITS as L,
  EXECUTION_STATUSES,
  FOLLOW_UP_CONDITIONS,
  QUICK_REPLY_ACTIONS,
  type FollowUpCondition,
} from "./comment-limits";
import { cancelFollowUps } from "./followups";
import { BUILT_IN_INTENTS, normalizeForMatch } from "./keywords";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export const fail = (status: number, error: string) => ({ ok: false as const, status, error });
export const done = <T>(data: T) => ({ ok: true as const, data });

export const NOT_FOUND = "Kampaniya topilmadi";
export const ACCOUNT_NOT_FOUND = "Instagram akkaunt topilmadi — u boshqa workspace'ga tegishli yoki uzilgan";

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

// ─── Small validators ─────────────────────────────────────────────────────────

/** Trimmed text, or null when empty. */
export const optionalText = (max: number, message: string) =>
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

// ─── Variants ─────────────────────────────────────────────────────────────────

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

/** Writes the variant plan for a campaign the caller already checked. Returns the stored list. */
export async function writeVariants(campaignId: string, input: VariantInput[]) {
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
  return prisma.triggerReplyVariant.findMany({ where: { campaignId }, orderBy: [{ kind: "asc" }, { sort: "asc" }] });
}

/** Approve / withdraw one variant, but only on a campaign of these trigger types in this workspace. */
export async function approveVariantIn(
  workspaceId: string,
  variantId: string,
  approved: boolean,
  triggerTypes: readonly InstagramEventType[]
) {
  const variant = await prisma.triggerReplyVariant.findFirst({
    where: { id: variantId, campaign: { workspaceId, triggerType: typeWhere(triggerTypes) } },
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

/** `"COMMENT"` for one type (keeps old queries readable), `{ in: [...] }` for several. */
export function typeWhere(
  triggerTypes: readonly InstagramEventType[]
): InstagramEventType | { in: InstagramEventType[] } {
  return triggerTypes.length === 1 ? triggerTypes[0] : { in: [...triggerTypes] };
}

// ─── Quick replies ────────────────────────────────────────────────────────────

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

export type QuickRepliesInput = z.infer<typeof quickRepliesInputSchema>["quickReplies"];

/** Ids are kept: a tap on a message sent earlier carries the old id. */
export async function writeQuickReplies(campaignId: string, input: QuickRepliesInput) {
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
  return prisma.triggerQuickReply.findMany({ where: { campaignId }, orderBy: { sort: "asc" } });
}

// ─── Follow-ups ───────────────────────────────────────────────────────────────

/**
 * Follow-up steps. `conditions` narrows the offered conditions: DM triggers
 * send no opening button, so "did not tap the button" means nothing there.
 */
export function followUpsSchema(
  conditions: readonly FollowUpCondition[] = FOLLOW_UP_CONDITIONS,
  notAllowed = "Bu shart bu kampaniya turida ishlamaydi"
) {
  return z
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
      input.steps.forEach((step, i) => {
        if (!conditions.includes(step.condition)) {
          ctx.addIssue({ code: "custom", path: ["steps", i, "condition"], message: notAllowed });
        }
        if (i > 0 && step.delayMinutes <= input.steps[i - 1].delayMinutes) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "delayMinutes"],
            message: `${i + 1}-follow-up ${i}-sidan keyinroq bo'lsin (kechikishlar o'sib borsin)`,
          });
        }
      });
    });
}

export const followUpsInputSchema = followUpsSchema();

export type FollowUpStepsInput = z.infer<typeof followUpsInputSchema>["steps"];

/**
 * Ids are kept so runs already scheduled for an unchanged step stay valid;
 * a removed step takes its scheduled runs with it (cascade).
 */
export async function writeFollowUpSteps(campaignId: string, input: FollowUpStepsInput) {
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
  return prisma.triggerFollowUpStep.findMany({ where: { campaignId }, orderBy: { sort: "asc" } });
}

export async function cancelExecutionFollowUpsIn(
  workspaceId: string,
  executionId: string,
  triggerTypes: readonly InstagramEventType[]
) {
  const execution = await prisma.triggerExecution.findFirst({
    where: { id: executionId, workspaceId, campaign: { triggerType: typeWhere(triggerTypes) } },
    select: { id: true },
  });
  if (!execution) return fail(404, "Bajarilish topilmadi");
  const cancelled = await cancelFollowUps(workspaceId, executionId, "Qo'lda bekor qilindi");
  return done({ cancelled });
}

// ─── Scoping ──────────────────────────────────────────────────────────────────

export async function accountInWorkspace(workspaceId: string, accountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true, instagramId: true, username: true, accessToken: true },
  });
}

// ─── Stats & logs ─────────────────────────────────────────────────────────────

export type Counts = Record<string, number>;

function bump(map: Map<string, Counts>, campaignId: string, key: string, count: number) {
  const entry = map.get(campaignId) ?? {};
  entry[key] = (entry[key] ?? 0) + count;
  map.set(campaignId, entry);
}

export type ExecutionStatusCounts = Record<(typeof EXECUTION_STATUSES)[number], number>;

export interface CampaignExecutionStats {
  executions: ExecutionStatusCounts;
  opened: number;
  leads: number;
  handoffs: number;
  followUps: Counts;
}

/** Per campaign: executions by status, opened / lead / handoff counts and follow-up runs by status. */
export async function executionStats(workspaceId: string, ids: string[]): Promise<Map<string, CampaignExecutionStats>> {
  const out = new Map<string, CampaignExecutionStats>();
  if (ids.length === 0) return out;
  const [byStatus, opened, leads, handoffs, steps, followUps] = await Promise.all([
    prisma.triggerExecution.groupBy({
      by: ["campaignId", "status"],
      where: { workspaceId, campaignId: { in: ids } },
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
  ]);

  const executions = new Map<string, Counts>();
  for (const row of byStatus) bump(executions, row.campaignId, row.status, row._count._all);
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

  for (const id of ids) {
    const e = executions.get(id) ?? {};
    const f = flags.get(id) ?? {};
    out.set(id, {
      executions: Object.fromEntries(EXECUTION_STATUSES.map((s) => [s, e[s] ?? 0])) as ExecutionStatusCounts,
      opened: f.opened ?? 0,
      leads: f.leads ?? 0,
      handoffs: f.handoffs ?? 0,
      followUps: followUpCounts.get(id) ?? {},
    });
  }
  return out;
}

export interface LogQuery {
  page?: number;
  limit?: number;
  status?: string | null;
}

/** One campaign's executions, newest first. The caller has checked the campaign. */
export async function listExecutionLogs(workspaceId: string, campaignId: string, query: LogQuery) {
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
            eventType: true,
            text: true,
            senderId: true,
            senderUsername: true,
            mediaId: true,
            storyUrl: true,
            referralSource: true,
            adId: true,
            ref: true,
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
