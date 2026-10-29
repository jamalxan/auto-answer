/**
 * ETAP 9 — the thin façade the /api/engagement routes talk to. It
 * owns giveaway CRUD (create / edit while DRAFT / list with counters / detail /
 * entries paging / delete while DRAFT), the zod schemas of the route bodies,
 * the overview, and turns thrown EngagementServiceError into the
 * `{ ok, status, error }` result every route answers with. The engines
 * (collector, draw, referral, points) live next to it and are re-exported
 * from the bottom of this file.
 *
 * Every function takes the workspace id first; a row of another workspace
 * reads as 404. Nothing here checks permissions — the guard does that per route.
 * `seedEncrypted` is never selected, so it can never reach a response.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { done, fail, firstIssue, type ServiceResult } from "@/lib/crm/result";
import { conflict, EngagementServiceError, notFound, unprocessable } from "./errors";
import { hashEntrants } from "./giveaway/draw";
import { giveawayRulesSchema, DEFAULT_RULES, RULE_VERIFIABILITY } from "./giveaway/rules";
import { countChangesAfterCommit } from "./giveaway/verify";
import { leaderboard } from "./leaderboard";

export { done, fail, firstIssue, type ServiceResult };
export { EngagementServiceError };

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_WINDOW_DAYS = 90;

export function toFailure(error: unknown): { ok: false; status: number; error: string } {
  if (error instanceof EngagementServiceError) return fail(error.status, error.message);
  return fail(500, error instanceof Error ? error.message : "Noma'lum xato");
}

export async function run<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return done(await fn());
  } catch (error) {
    return toFailure(error);
  }
}

export const GIVEAWAY_NOT_FOUND = "Giveaway topilmadi";

// ─── Schemas for route bodies ────────────────────────────────────────────────

const isoDate = z.coerce.date({ error: "Sana noto'g'ri" });

export const giveawayInputSchema = z.object({
  name: z.string().trim().min(1, "Nom kerak").max(120, "Nom 120 belgidan oshmasin"),
  instagramAccountId: z.string().min(1, "Akkaunt kerak"),
  mediaId: z.string().trim().min(1, "Post tanlang").max(100),
  mediaMeta: z.record(z.string(), z.unknown()).nullish(),
  rules: z.unknown().optional(),
  windowStart: isoDate,
  windowEnd: isoDate,
  winnersCount: z.number().int("Butun son kerak").min(1, "Kamida 1 g'olib").max(50, "G'oliblar soni 50 dan oshmasin"),
  backupCount: z.number().int("Butun son kerak").min(0).max(20, "Zaxira 20 dan oshmasin").default(0),
  confirmCampaignId: z.string().min(1).nullish(),
});
export type GiveawayInput = z.input<typeof giveawayInputSchema>;
type ParsedInput = z.output<typeof giveawayInputSchema>;

export const giveawayPatchSchema = giveawayInputSchema.partial();

export const giveawaysQuerySchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "CLOSED", "DRAWN", "ARCHIVED"]).optional(),
});

export const ENTRY_STATUSES = ["ELIGIBLE", "INELIGIBLE", "PENDING_CHECK", "WINNER", "DISQUALIFIED"] as const;

export const entriesQuerySchema = z.object({
  status: z.enum(ENTRY_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const entryActionSchema = z.object({
  action: z.enum(["mark-eligible", "mark-ineligible", "disqualify"]),
  reason: z.string().trim().max(300).optional(),
});

export const verifyBodySchema = z.object({
  seedHex: z.string().regex(/^[0-9a-f]{64}$/, "seedHex 64 ta kichik hex belgi bo'lishi kerak"),
  commitment: z.string().regex(/^[0-9a-f]{64}$/, "commitment 64 ta kichik hex belgi bo'lishi kerak").optional(),
  /** Public identities (igUserId) of every eligible entrant. */
  entrants: z.array(z.string().min(1).max(64)).max(100_000),
  winnersCount: z.number().int().min(1).max(50).optional(),
  backupCount: z.number().int().min(0).max(20).optional(),
  winners: z.array(z.string().min(1).max(64)).max(100),
  backups: z.array(z.string().min(1).max(64)).max(100).optional(),
});

export const gamificationLedgerQuerySchema = z.object({
  contactId: z.string().max(60).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const leaderboardQuerySchema = z.object({
  period: z.enum(["7d", "30d", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Referral

export const programQuerySchema = z.object({ accountId: z.string().min(1, "accountId kerak").max(60) });

export const codesQuerySchema = z.object({
  programId: z.string().min(1, "programId kerak").max(60),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const codeCreateSchema = z
  .object({
    programId: z.string().min(1, "programId kerak").max(60),
    contactId: z.string().min(1).max(60).optional(),
    igUserId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.contactId || v.igUserId, { message: "Kontaktni tanlang" });

export const referralEventsQuerySchema = z.object({
  programId: z.string().max(60).optional(),
  status: z.enum(["PENDING", "QUALIFIED", "REWARDED", "REJECTED"]).optional(),
  flagged: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reviewBodySchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().max(300).optional(),
});

export const referralStatsQuerySchema = z.object({ programId: z.string().min(1, "programId kerak").max(60) });

/** The program must belong to the workspace; returns what the link needs. */
export async function programScope(workspaceId: string, programId: string) {
  const program = await prisma.referralProgram.findFirst({ where: { id: programId, workspaceId }, select: { id: true, instagramAccountId: true } });
  if (!program) throw notFound("Referral dasturi topilmadi");
  const account = await prisma.instagramAccount.findFirst({ where: { id: program.instagramAccountId, workspaceId }, select: { username: true } });
  return { programId: program.id, accountId: program.instagramAccountId, username: account?.username ?? null };
}

// ─── Giveaway rows (never selects the encrypted seed) ───────────────────────

export const GIVEAWAY_SELECT = {
  id: true,
  workspaceId: true,
  instagramAccountId: true,
  name: true,
  description: true,
  mediaId: true,
  mediaMeta: true,
  rules: true,
  windowStart: true,
  windowEnd: true,
  status: true,
  winnersCount: true,
  backupCount: true,
  seedCommitment: true,
  committedAt: true,
  confirmCampaignId: true,
  backfillStatus: true,
  backfillScanned: true,
  backfillError: true,
  entriesCount: true,
  eligibleCount: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Defence in depth: whatever a row carries, the seed never leaves the service. */
export function stripSecrets<T extends object>(row: T): Omit<T, "seedEncrypted"> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.seedEncrypted;
  return copy as Omit<T, "seedEncrypted">;
}

const DRAW_SELECT = {
  id: true,
  giveawayId: true,
  sequence: true,
  algorithm: true,
  seedCommitment: true,
  seedRevealed: true,
  entrantsHash: true,
  entrantsCount: true,
  winnersCount: true,
  winnerEntryIds: true,
  backupEntryIds: true,
  verification: true,
  status: true,
  drawnAt: true,
  confirmedAt: true,
  confirmedByUserId: true,
  voidedAt: true,
  voidReason: true,
} as const;

async function requireGiveaway(workspaceId: string, id: string) {
  const row = await prisma.giveaway.findFirst({ where: { id, workspaceId }, select: GIVEAWAY_SELECT });
  if (!row) throw notFound(GIVEAWAY_NOT_FOUND);
  return stripSecrets(row);
}

// ─── Validation shared by create and update ──────────────────────────────────

interface Validated {
  name: string;
  instagramAccountId: string;
  mediaId: string;
  mediaMeta: Prisma.InputJsonValue | undefined;
  rules: Prisma.InputJsonValue;
  windowStart: Date;
  windowEnd: Date;
  winnersCount: number;
  backupCount: number;
  confirmCampaignId: string | null;
}

async function validate(workspaceId: string, input: ParsedInput, options: { requireFutureEnd: boolean }): Promise<Validated> {
  const account = await prisma.instagramAccount.findFirst({ where: { id: input.instagramAccountId, workspaceId }, select: { id: true } });
  if (!account) throw notFound("Instagram akkaunt topilmadi");

  const mediaId = input.mediaId.trim();
  if (!mediaId) throw unprocessable("Post tanlanmagan");

  const { windowStart, windowEnd } = input;
  if (!(windowEnd.getTime() > windowStart.getTime())) throw unprocessable("Tugash vaqti boshlanishdan keyin bo'lishi kerak");
  if (windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw unprocessable(`Davr ${MAX_WINDOW_DAYS} kundan uzun bo'lmasin`);
  }
  if (options.requireFutureEnd && windowEnd.getTime() <= Date.now()) {
    throw unprocessable("Tugash vaqti o'tib ketgan — kelajakdagi vaqtni tanlang");
  }

  const rulesParsed = giveawayRulesSchema.safeParse(input.rules ?? DEFAULT_RULES);
  if (!rulesParsed.success) throw unprocessable(`Qoidalar noto'g'ri: ${firstIssue(rulesParsed.error)}`);

  let confirmCampaignId: string | null = null;
  if (input.confirmCampaignId) {
    const campaign = await prisma.triggerCampaign.findFirst({
      where: { id: input.confirmCampaignId, workspaceId },
      select: { id: true, triggerType: true, instagramAccountId: true },
    });
    if (!campaign) throw notFound("Tasdiq kampaniyasi topilmadi");
    if (campaign.triggerType !== "COMMENT" || campaign.instagramAccountId !== account.id) {
      throw unprocessable("Tasdiq kampaniyasi shu akkauntning Comment 2.0 (komment) kampaniyasi bo'lishi kerak");
    }
    confirmCampaignId = campaign.id;
  }

  return {
    name: input.name.trim(),
    instagramAccountId: account.id,
    mediaId,
    mediaMeta: (input.mediaMeta ?? undefined) as Prisma.InputJsonValue | undefined,
    rules: rulesParsed.data as Prisma.InputJsonValue,
    windowStart,
    windowEnd,
    winnersCount: input.winnersCount,
    backupCount: input.backupCount ?? 0,
    confirmCampaignId,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createGiveaway(workspaceId: string, input: GiveawayInput, userId: string | null = null) {
  const parsed = giveawayInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const v = await validate(workspaceId, parsed.data, { requireFutureEnd: true });
  const created = await prisma.giveaway.create({
    data: {
      workspaceId,
      instagramAccountId: v.instagramAccountId,
      name: v.name,
      mediaId: v.mediaId,
      mediaMeta: v.mediaMeta,
      rules: v.rules,
      windowStart: v.windowStart,
      windowEnd: v.windowEnd,
      status: "DRAFT",
      winnersCount: v.winnersCount,
      backupCount: v.backupCount,
      confirmCampaignId: v.confirmCampaignId,
      entriesCount: 0,
      eligibleCount: 0,
      backfillScanned: 0,
      createdByUserId: userId,
    },
    select: GIVEAWAY_SELECT,
  });
  return stripSecrets(created);
}

/** Only a DRAFT can be edited: once ACTIVE the rules are what people entered under. */
export async function updateGiveaway(workspaceId: string, id: string, patch: Partial<GiveawayInput>) {
  const existing = await requireGiveaway(workspaceId, id);
  if (existing.status !== "DRAFT") {
    throw conflict("Faqat qoralama (DRAFT) giveaway tahrirlanadi: faollashtirilgandan keyin qoidalar o'zgarmaydi");
  }
  const merged = giveawayInputSchema.safeParse({
    name: patch.name ?? existing.name,
    instagramAccountId: patch.instagramAccountId ?? existing.instagramAccountId,
    mediaId: patch.mediaId ?? existing.mediaId,
    mediaMeta: patch.mediaMeta === undefined ? existing.mediaMeta : patch.mediaMeta,
    rules: patch.rules === undefined ? existing.rules : patch.rules,
    windowStart: patch.windowStart ?? existing.windowStart,
    windowEnd: patch.windowEnd ?? existing.windowEnd,
    winnersCount: patch.winnersCount ?? existing.winnersCount,
    backupCount: patch.backupCount ?? existing.backupCount,
    confirmCampaignId: patch.confirmCampaignId === undefined ? existing.confirmCampaignId : patch.confirmCampaignId,
  });
  if (!merged.success) throw unprocessable(firstIssue(merged.error));
  const v = await validate(workspaceId, merged.data, { requireFutureEnd: false });
  const updated = await prisma.giveaway.update({
    where: { id },
    data: {
      name: v.name,
      instagramAccountId: v.instagramAccountId,
      mediaId: v.mediaId,
      mediaMeta: v.mediaMeta,
      rules: v.rules,
      windowStart: v.windowStart,
      windowEnd: v.windowEnd,
      winnersCount: v.winnersCount,
      backupCount: v.backupCount,
      confirmCampaignId: v.confirmCampaignId,
    },
    select: GIVEAWAY_SELECT,
  });
  return stripSecrets(updated);
}

export async function deleteGiveaway(workspaceId: string, id: string) {
  const existing = await requireGiveaway(workspaceId, id);
  if (existing.status !== "DRAFT") {
    throw conflict("Faqat qoralama (DRAFT) o'chiriladi. Boshlangan giveaway'ni arxivlang — tarix saqlanadi");
  }
  await prisma.giveaway.delete({ where: { id } });
  return { deleted: true };
}

export async function listGiveaways(workspaceId: string, options: { status?: string } = {}) {
  const rows = await prisma.giveaway.findMany({
    where: { workspaceId, ...(options.status ? { status: options.status as never } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: GIVEAWAY_SELECT,
  });
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId, id: { in: [...new Set(rows.map((r) => r.instagramAccountId))] } },
    select: { id: true, username: true },
  });
  const names = new Map(accounts.map((a) => [a.id, a.username]));
  return Promise.all(
    rows.map(async (row) => ({
      ...stripSecrets(row),
      accountUsername: names.get(row.instagramAccountId) ?? null,
      pendingCount: await prisma.giveawayEntry.count({ where: { giveawayId: row.id, status: "PENDING_CHECK" } }),
    }))
  );
}

export async function getGiveaway(workspaceId: string, id: string) {
  return requireGiveaway(workspaceId, id);
}

/** The entry must belong to this giveaway and workspace, otherwise 404 (no id probing across tenants). */
export async function requireEntry(workspaceId: string, giveawayId: string, entryId: string) {
  const row = await prisma.giveawayEntry.findFirst({ where: { id: entryId, giveawayId, workspaceId } });
  if (!row) throw notFound("Ishtirokchi topilmadi");
  return row;
}

/** Entry statuses, in the order the UI shows the counters. */
export async function entryStatusCounts(giveawayId: string): Promise<Record<string, number>> {
  const counts = await Promise.all(ENTRY_STATUSES.map((status) => prisma.giveawayEntry.count({ where: { giveawayId, status } })));
  return Object.fromEntries(ENTRY_STATUSES.map((status, i) => [status, counts[i]]));
}

export interface ListEntriesOptions {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/** Newest comment first, keyset-paged by entry id. */
export async function listEntries(workspaceId: string, giveawayId: string, options: ListEntriesOptions = {}) {
  await requireGiveaway(workspaceId, giveawayId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const q = options.q?.trim().replace(/^@/, "");
  const where: Prisma.GiveawayEntryWhereInput = {
    giveawayId,
    workspaceId,
    ...(options.status ? { status: options.status as never } : {}),
    ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { firstCommentText: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const rows = await prisma.giveawayEntry.findMany({
    where,
    orderBy: [{ firstCommentAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  return { entries, nextCursor: hasMore ? entries[entries.length - 1].id : null };
}

/** Giveaway + draws (with their winners) + notification summary + verifiability labels + backfill state. */
export async function getGiveawayDetail(workspaceId: string, id: string) {
  const giveaway = await requireGiveaway(workspaceId, id);
  const [draws, notifications, counts, account] = await Promise.all([
    prisma.giveawayDraw.findMany({ where: { giveawayId: id, workspaceId }, orderBy: { sequence: "asc" }, select: DRAW_SELECT }),
    prisma.giveawayNotification.findMany({ where: { giveawayId: id }, orderBy: { createdAt: "asc" } }),
    entryStatusCounts(id),
    prisma.instagramAccount.findFirst({ where: { id: giveaway.instagramAccountId, workspaceId }, select: { username: true } }),
  ]);
  // The list the commitment was published over: frozen at close, but the owner may still decide
  // PENDING entries while CLOSED, so the live hash / count and the number of such changes are shown.
  let commitment: { entrantsCount: number; entrantsHash: string; changesAfterCommit: number } | null = null;
  if (giveaway.status === "CLOSED" || giveaway.status === "DRAWN") {
    const rows = await prisma.giveawayEntry.findMany({ where: { giveawayId: id }, select: { igUserId: true, status: true, checks: true } });
    const eligible = rows.filter((row) => row.status === "ELIGIBLE");
    commitment = {
      entrantsCount: eligible.length,
      entrantsHash: hashEntrants(eligible),
      changesAfterCommit: countChangesAfterCommit(rows, giveaway.committedAt),
    };
  }
  const entryIds = [...new Set(draws.flatMap((d) => [...d.winnerEntryIds, ...d.backupEntryIds]))];
  const entryRows = entryIds.length
    ? await prisma.giveawayEntry.findMany({
        where: { giveawayId: id, id: { in: entryIds } },
        select: { id: true, igUserId: true, username: true, firstCommentId: true, firstCommentText: true, status: true },
      })
    : [];
  const byId = new Map(entryRows.map((e) => [e.id, e]));
  const notificationsByEntry: Record<string, Array<{ channel: string; status: string; reason: string | null; createdAt: Date }>> = {};
  for (const n of notifications) {
    (notificationsByEntry[n.entryId] ??= []).push({ channel: n.channel, status: n.status, reason: n.reason, createdAt: n.createdAt });
  }
  return {
    giveaway: { ...giveaway, accountUsername: account?.username ?? null },
    counts,
    commitment,
    draws: draws.map((d) => ({
      ...d,
      winners: d.winnerEntryIds.map((entryId) => byId.get(entryId) ?? { id: entryId }),
      backups: d.backupEntryIds.map((entryId) => byId.get(entryId) ?? { id: entryId }),
    })),
    notifications: notificationsByEntry,
    verifiability: RULE_VERIFIABILITY,
    backfill: { status: giveaway.backfillStatus, scanned: giveaway.backfillScanned, error: giveaway.backfillError },
  };
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function overview(workspaceId: string) {
  const statuses = ["DRAFT", "ACTIVE", "CLOSED", "DRAWN", "ARCHIVED"] as const;
  const [counts, pendingEvents, top] = await Promise.all([
    Promise.all(statuses.map((status) => prisma.giveaway.count({ where: { workspaceId, status } }))),
    prisma.referralEvent.findMany({ where: { workspaceId, status: "PENDING" }, take: 500, select: { id: true, fraudFlags: true } }),
    Promise.resolve()
      .then(() => leaderboard(workspaceId, { period: "all", limit: 5 }))
      .catch(() => []),
  ]);
  return {
    giveaways: Object.fromEntries(statuses.map((s, i) => [s, counts[i]])) as Record<(typeof statuses)[number], number>,
    referral: {
      pending: pendingEvents.length,
      needsReview: pendingEvents.filter((e) => (e.fraudFlags?.length ?? 0) > 0).length,
    },
    leaderboard: top,
  };
}

// ─── Engines (re-exported so routes import from one place) ───────────────────

export { isEngagementEnabled, BACKFILL_CAP } from "./config";
export { giveawayRulesSchema, DEFAULT_RULES, RULE_VERIFIABILITY, evaluateEntry } from "./giveaway/rules";
export { verifyDraw } from "./giveaway/draw";
export {
  activateGiveaway,
  closeAndCommit,
  drawGiveaway,
  confirmDraw,
  disqualifyEntry,
  markEntry,
  resolveUnverifiable,
  archiveGiveaway,
  verifyStoredDraw,
} from "./giveaway/lifecycle";
export { startBackfill } from "./giveaway/backfill";
export { notifyWinners } from "./giveaway/notify";
export { exportEntriesCsv, exportDrawRecord } from "./giveaway/export";
export { getProgram, saveProgram, listReferralEvents, reviewReferralEvent, referralStats } from "./referral/program";
export { createReferralCode, listCodes, referralLink } from "./referral/codes";
export { FRAUD_FLAG_LABELS } from "./referral/fraud";
export { getSettings, saveSettings, DEFAULT_POINTS_RULES, DEFAULT_BADGES, POINT_REASON_LABELS } from "./settings";
export { leaderboard, ledger } from "./leaderboard";
