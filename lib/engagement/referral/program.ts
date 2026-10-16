/**
 * ETAP 9.3 — the referral program service: one program per Instagram account
 * (`instagramAccountId @unique`), its events and the owner's review of flagged
 * ones. The service layer (lib/engagement/service.ts, API routes) calls these.
 */

import { z } from "zod";
import type { Prisma, ReferralEvent, ReferralEventStatus, ReferralProgram } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { forgetEngagementGate } from "../gate";
import { conflict, notFound, unprocessable } from "../errors";
import { parseFlags } from "./fraud";
import { forceQualifyAndReward } from "./qualification";
import { ACTIVATED_KEY, activatedAtOf, parseRewardRules, rewardRulesSchema, type RewardRules } from "./reward";

export const programInputSchema = z.object({
  name: z.string().trim().min(1, "Dastur nomi kiritilmagan").max(80, "Dastur nomi 80 belgidan oshmasin"),
  active: z.boolean(),
  qualifier: z.enum(["FIRST_MESSAGE", "LEAD", "PURCHASE"], { message: "Noto'g'ri shart" }),
  rewardRules: rewardRulesSchema,
  burstLimitPerDay: z
    .number({ message: "Limit son bo'lishi kerak" })
    .int("Limit butun son bo'lsin")
    .min(1, "Limit kamida 1 bo'lsin")
    .max(200, "Limit 200 dan oshmasin"),
});
export type ProgramInput = z.input<typeof programInputSchema>;

export interface ProgramView {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  name: string;
  active: boolean;
  qualifier: ReferralProgram["qualifier"];
  rewardRules: RewardRules;
  burstLimitPerDay: number;
  /** Events before this are history and never rewarded. */
  activatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function view(program: ReferralProgram): ProgramView {
  return {
    id: program.id,
    workspaceId: program.workspaceId,
    instagramAccountId: program.instagramAccountId,
    name: program.name,
    active: program.active,
    qualifier: program.qualifier,
    rewardRules: parseRewardRules(program.rewardRules),
    burstLimitPerDay: program.burstLimitPerDay,
    activatedAt: activatedAtOf(program),
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

async function requireAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId } });
  if (!account) throw notFound("Instagram akkaunt topilmadi");
  return account;
}

export async function getProgram(workspaceId: string, accountId: string): Promise<ProgramView | null> {
  await requireAccount(workspaceId, accountId);
  const program = await prisma.referralProgram.findUnique({ where: { instagramAccountId: accountId } });
  return program && program.workspaceId === workspaceId ? view(program) : null;
}

export async function saveProgram(workspaceId: string, accountId: string, input: unknown): Promise<ProgramView> {
  const parsed = programInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  await requireAccount(workspaceId, accountId);

  const existing = await prisma.referralProgram.findUnique({ where: { instagramAccountId: accountId } });
  if (existing && existing.workspaceId !== workspaceId) throw notFound("Instagram akkaunt topilmadi");

  // Switching ON stamps the activation time inside the rules JSON (no extra column): history stays unrewarded.
  const now = new Date();
  const switchedOn = parsed.data.active && (!existing || !existing.active);
  const activatedAt = switchedOn ? now : existing ? activatedAtOf(existing) : now;
  const rewardRules = { ...parsed.data.rewardRules, [ACTIVATED_KEY]: activatedAt.toISOString() };

  const data = {
    name: parsed.data.name,
    active: parsed.data.active,
    qualifier: parsed.data.qualifier,
    rewardRules,
    burstLimitPerDay: parsed.data.burstLimitPerDay,
  };
  const saved = existing
    ? await prisma.referralProgram.update({ where: { id: existing.id }, data })
    : await prisma.referralProgram.create({ data: { workspaceId, instagramAccountId: accountId, ...data } });

  // The webhook gate caches "engaged" per account: refresh it so the ref events start (or stop) being stored.
  await forgetEngagementGate(accountId);
  return view(saved);
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface ReferralEventItem {
  id: string;
  programId: string;
  codeId: string;
  referrerIgUserId: string;
  referrerContactId: string | null;
  referrerUsername: string | null;
  refereeIgUserId: string;
  refereeContactId: string | null;
  refereeUsername: string | null;
  status: ReferralEventStatus;
  qualifiedAt: Date | null;
  qualifiedBy: ReferralEvent["qualifiedBy"];
  rewardedAt: Date | null;
  rewardSnapshot: unknown;
  fraudFlags: string[];
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  rejectReason: string | null;
  createdAt: Date;
}

async function decorate(workspaceId: string, rows: ReferralEvent[]): Promise<ReferralEventItem[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.referrerContactId, row.refereeContactId]).filter((id): id is string => Boolean(id)))];
  const contacts = ids.length
    ? await prisma.crmContact.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, username: true } })
    : [];
  const usernames = new Map(contacts.map((contact) => [contact.id, contact.username]));
  return rows.map((row) => ({
    id: row.id,
    programId: row.programId,
    codeId: row.codeId,
    referrerIgUserId: row.referrerIgUserId,
    referrerContactId: row.referrerContactId ?? null,
    referrerUsername: row.referrerContactId ? (usernames.get(row.referrerContactId) ?? null) : null,
    refereeIgUserId: row.refereeIgUserId,
    refereeContactId: row.refereeContactId ?? null,
    refereeUsername: row.refereeContactId ? (usernames.get(row.refereeContactId) ?? null) : null,
    status: row.status,
    qualifiedAt: row.qualifiedAt ?? null,
    qualifiedBy: row.qualifiedBy ?? null,
    rewardedAt: row.rewardedAt ?? null,
    rewardSnapshot: row.rewardSnapshot ?? null,
    fraudFlags: parseFlags(row.fraudFlags),
    reviewedAt: row.reviewedAt ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    rejectReason: row.rejectReason ?? null,
    createdAt: row.createdAt,
  }));
}

export async function listReferralEvents(
  workspaceId: string,
  options: { programId?: string; status?: ReferralEventStatus; flagged?: boolean; cursor?: string | null; limit?: number } = {}
): Promise<{ items: ReferralEventItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const rows = await prisma.referralEvent.findMany({
    where: {
      workspaceId,
      ...(options.programId ? { programId: options.programId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.flagged === undefined ? {} : { fraudFlags: { isEmpty: !options.flagged } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  // The database already filtered; this keeps the answer right on a store without array filters.
  const filtered = options.flagged === undefined ? page : page.filter((row) => (row.fraudFlags.length > 0) === options.flagged);
  return {
    items: await decorate(workspaceId, filtered),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

export type ReviewDecision = "APPROVE" | "REJECT";

/**
 * The owner's decision on a flagged event.
 *   APPROVE  lifts the review hold of a flagged event: a QUALIFIED one is rewarded now, a PENDING one
 *            is qualified + rewarded now only if its condition is already met (otherwise it waits
 *            for the friend's qualifying action, which the listener / sweep then rewards)
 *   REJECT   the event becomes REJECTED (never rewarded); a REWARDED one cannot be undone here
 */
export async function reviewReferralEvent(
  workspaceId: string,
  eventId: string,
  decision: ReviewDecision,
  userId: string,
  reason?: string | null,
  now: Date = new Date()
): Promise<ReferralEventItem> {
  const event = await prisma.referralEvent.findFirst({ where: { id: eventId, workspaceId } });
  if (!event) throw notFound("Taklif topilmadi");

  if (decision === "REJECT") {
    if (event.status === "REWARDED") throw conflict("Mukofotlangan taklifni rad etib bo'lmaydi");
    if (event.status !== "REJECTED") {
      await prisma.referralEvent.updateMany({
        where: { id: event.id, status: { in: ["PENDING", "QUALIFIED"] } },
        data: { status: "REJECTED", reviewedAt: now, reviewedByUserId: userId, rejectReason: reason?.trim().slice(0, 300) || null },
      });
    }
  } else if (decision === "APPROVE") {
    if (event.status === "REJECTED") throw conflict("Rad etilgan taklifni tasdiqlab bo'lmaydi");
    if (event.status !== "REWARDED") {
      if (event.fraudFlags.length === 0) throw unprocessable("Bu taklif tekshiruvni talab qilmaydi");
      // Approval lifts the review hold only; the qualification condition still decides (qualification.ts).
      const held = event.rewardSnapshot && typeof event.rewardSnapshot === "object" && !Array.isArray(event.rewardSnapshot);
      await prisma.referralEvent.updateMany({
        where: { id: event.id, status: { in: ["PENDING", "QUALIFIED"] } },
        data: {
          reviewedAt: now,
          reviewedByUserId: userId,
          ...(event.status === "PENDING" && held
            ? { rewardSnapshot: { ...(event.rewardSnapshot as Record<string, unknown>), awaitingReview: false } as Prisma.InputJsonValue }
            : {}),
        },
      });
      await forceQualifyAndReward(event.id, now);
    }
  } else {
    throw unprocessable("Noto'g'ri qaror");
  }

  const fresh = await prisma.referralEvent.findUnique({ where: { id: event.id } });
  return (await decorate(workspaceId, [fresh ?? event]))[0];
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface ReferrerStat {
  referrerIgUserId: string;
  contactId: string | null;
  username: string | null;
  pending: number;
  qualified: number;
  rewarded: number;
  rejected: number;
  total: number;
}

export interface ReferralStats {
  totals: { pending: number; qualified: number; rewarded: number; rejected: number; flagged: number; total: number };
  referrers: ReferrerStat[];
  topReferrers: ReferrerStat[];
}

const STATS_EVENT_CAP = 20_000;

export async function referralStats(workspaceId: string, programId: string): Promise<ReferralStats> {
  const program = await prisma.referralProgram.findFirst({ where: { id: programId, workspaceId } });
  if (!program) throw notFound("Referral dasturi topilmadi");
  const rows = await prisma.referralEvent.findMany({
    where: { workspaceId, programId },
    select: { referrerIgUserId: true, referrerContactId: true, status: true, fraudFlags: true, reviewedAt: true },
    take: STATS_EVENT_CAP,
  });

  const totals = { pending: 0, qualified: 0, rewarded: 0, rejected: 0, flagged: 0, total: rows.length };
  const byReferrer = new Map<string, ReferrerStat>();
  for (const row of rows) {
    const stat =
      byReferrer.get(row.referrerIgUserId) ??
      ({ referrerIgUserId: row.referrerIgUserId, contactId: row.referrerContactId ?? null, username: null, pending: 0, qualified: 0, rewarded: 0, rejected: 0, total: 0 } as ReferrerStat);
    stat.total++;
    if (row.status === "PENDING") {
      stat.pending++;
      totals.pending++;
    } else if (row.status === "QUALIFIED") {
      stat.qualified++;
      totals.qualified++;
    } else if (row.status === "REWARDED") {
      stat.rewarded++;
      totals.rewarded++;
    } else if (row.status === "REJECTED") {
      stat.rejected++;
      totals.rejected++;
    }
    if (row.fraudFlags.length > 0 && !row.reviewedAt && row.status === "PENDING") totals.flagged++;
    byReferrer.set(row.referrerIgUserId, stat);
  }

  const contactIds = [...byReferrer.values()].map((stat) => stat.contactId).filter((id): id is string => Boolean(id));
  const contacts = contactIds.length
    ? await prisma.crmContact.findMany({ where: { workspaceId, id: { in: contactIds } }, select: { id: true, username: true } })
    : [];
  const usernames = new Map(contacts.map((contact) => [contact.id, contact.username]));
  const referrers = [...byReferrer.values()]
    .map((stat) => ({ ...stat, username: stat.contactId ? (usernames.get(stat.contactId) ?? null) : null }))
    .sort((a, b) => b.rewarded - a.rewarded || b.qualified - a.qualified || b.total - a.total || a.referrerIgUserId.localeCompare(b.referrerIgUserId));
  return { totals, referrers, topReferrers: referrers.slice(0, 10) };
}
