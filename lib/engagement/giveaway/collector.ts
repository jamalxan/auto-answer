/**
 * Live giveaway collector: InstagramEvent rows → GiveawayEntry rows.
 *
 * Runs from the engagement maintenance tick (about once a minute). For every
 * ACTIVE giveaway it reads the account's COMMENT events on the giveaway post
 * (also an ad's `original_media_id`) and STORY_MENTION events, at most
 * COLLECT_BATCH per giveaway per tick, with a keyset cursor on the giveaway
 * row (createdAt, id — insertion order, so a late-stored backtrack event is
 * never skipped). The event `timestamp` must lie inside the giveaway window.
 *
 * One entry per person (database unique key): a later comment adds its
 * @handles and counts, a story mention sets mentionedAt. The entry is
 * (re)evaluated by the pure rules (rules.ts). Entries the owner decided by
 * hand (checks.manual) or that already won / were disqualified keep their
 * status. Follow checks run after the batch (follow.ts), only when the rules
 * require them.
 *
 * Only the owner closes a giveaway: the window end stops entries, not the
 * status.
 */

import { prisma } from "@/lib/db/client";
import type { Giveaway, GiveawayEntry, InstagramAccount, Prisma } from "@/app/generated/prisma/client";
import { readAccessToken } from "@/lib/triggers/delivery";
import { COLLECT_BATCH, isEngagementEnabled } from "../config";
import { awardPoints } from "../points";
import { checkFollow, followCheckDue, FOLLOW_BUDGET_PER_TICK, FOLLOW_RECHECK_MS } from "./follow";
import {
  commentPasses,
  evaluateEntry,
  extractTaggedHandles,
  parseRules,
  type EntryEvaluation,
  type FollowResult,
  type GiveawayRules,
} from "./rules";

type CollectAccount = Pick<InstagramAccount, "id" | "instagramId" | "username" | "accessToken" | "tokenStatus" | "tokenLastError">;

export interface CollectContext {
  giveaway: Pick<Giveaway, "id" | "workspaceId" | "instagramAccountId" | "mediaId" | "windowStart" | "windowEnd">;
  rules: GiveawayRules;
  account: Pick<CollectAccount, "instagramId" | "username">;
  now: Date;
}

export interface Participation {
  igUserId: string;
  username?: string | null;
  kind: "COMMENT" | "MENTION";
  commentId?: string;
  text?: string;
  at: Date;
  /** The InstagramEvent this came from; null for backfilled comments. */
  eventId?: string | null;
  /** Backfill: handles of all the person's comments, written in one go. */
  extraHandles?: string[];
  /** Backfill: the person's total comment count (absolute, not an increment). */
  commentCount?: number;
}

export interface CollectorSummary {
  giveaways: number;
  scanned: number;
  created: number;
  updated: number;
  followChecks: number;
}

const MAX_SOURCE_EVENTS = 50;
const MEDIA_ID_PATH = ["item", "value", "media", "original_media_id"];

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/** The owner decided this entry by hand: the collector never overrides it. */
export function isManualEntry(entry: Pick<GiveawayEntry, "checks">): boolean {
  const checks = entry.checks as Record<string, unknown> | null;
  return Boolean(checks && typeof checks === "object" && "manual" in checks);
}

function isFrozen(entry: Pick<GiveawayEntry, "status" | "checks">): boolean {
  return entry.status === "WINNER" || entry.status === "DISQUALIFIED" || isManualEntry(entry);
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function verdictData(evaluation: EntryEvaluation) {
  return {
    status: evaluation.status,
    ineligibleReason: evaluation.status === "INELIGIBLE" ? evaluation.reason : null,
    checks: evaluation.checks as unknown as Prisma.InputJsonValue,
  };
}

async function findContactId(workspaceId: string, instagramAccountId: string, igUserId: string): Promise<string | null> {
  try {
    const contact = await prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } },
      select: { id: true, workspaceId: true },
    });
    return contact && contact.workspaceId === workspaceId ? contact.id : null;
  } catch {
    return null;
  }
}

/**
 * "giveaway_entry" points: once per created entry, only when the person is
 * already a CRM contact (no contact → silently nothing). awardPoints respects
 * the workspace's enable flag and never throws.
 */
async function awardEntryPoints(
  workspaceId: string,
  instagramAccountId: string,
  entry: { id: string; igUserId: string; contactId: string | null },
  occurredAt: Date
): Promise<void> {
  const contactId = entry.contactId ?? (await findContactId(workspaceId, instagramAccountId, entry.igUserId));
  if (!contactId) return;
  await awardPoints({
    workspaceId,
    contactId,
    reason: "giveaway_entry",
    sourceTable: "GiveawayEntry",
    sourceId: entry.id,
    occurredAt,
  });
}

/**
 * Apply one participation (a comment or a story mention) to the person's
 * entry: create it or merge into it, evaluate the rules, store the verdict.
 * Shared by the live collector and the backfill. Idempotent per event / comment.
 */
export async function recordParticipation(ctx: CollectContext, p: Participation): Promise<"created" | "updated" | "ignored"> {
  const { giveaway, rules, account, now } = ctx;
  if (!p.igUserId || p.igUserId === account.instagramId) return "ignored";

  const where = { giveawayId_igUserId: { giveawayId: giveaway.id, igUserId: p.igUserId } };
  let existing = await prisma.giveawayEntry.findUnique({ where });

  if (!existing) {
    const isComment = p.kind === "COMMENT";
    // A story mention alone never makes someone a participant: it only counts
    // when the rules ask for it (otherwise the person must have commented first).
    if (!isComment && !rules.mention.required) return "ignored";
    const text = isComment ? (p.text ?? "") : "";
    const handles = isComment ? union(extractTaggedHandles(text, account.username), p.extraHandles ?? []) : [];
    const evaluation = evaluateEntry(
      rules,
      {
        igUserId: p.igUserId,
        username: p.username,
        commentText: text,
        taggedUsernames: handles,
        mentionedAt: isComment ? null : p.at,
        followResult: "NOT_CHECKED",
      },
      now
    );
    try {
      const created = await prisma.giveawayEntry.create({
        data: {
          giveawayId: giveaway.id,
          workspaceId: giveaway.workspaceId,
          igUserId: p.igUserId,
          username: p.username ?? null,
          contactId: await findContactId(giveaway.workspaceId, giveaway.instagramAccountId, p.igUserId),
          firstCommentId: isComment ? (p.commentId ?? "") : "",
          firstCommentText: text,
          firstCommentAt: p.at,
          commentCount: isComment ? Math.max(1, p.commentCount ?? 1) : 0,
          sourceEventIds: p.eventId ? [p.eventId] : [],
          mentionEventId: isComment ? null : (p.eventId ?? null),
          mentionedAt: isComment ? null : p.at,
          taggedUsernames: handles,
          ...verdictData(evaluation),
        },
      });
      await awardEntryPoints(giveaway.workspaceId, giveaway.instagramAccountId, created, p.at);
      return "created";
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another worker created it a moment ago: merge into that one.
      existing = await prisma.giveawayEntry.findUnique({ where });
      if (!existing) throw error;
    }
  }

  return mergeIntoEntry(ctx, existing, p);
}

async function mergeIntoEntry(ctx: CollectContext, entry: GiveawayEntry, p: Participation): Promise<"updated" | "ignored"> {
  const { rules, account, now } = ctx;
  const data: Prisma.GiveawayEntryUpdateInput = {};
  let commentText = entry.firstCommentText;
  let handles = entry.taggedUsernames;
  let mentionedAt = entry.mentionedAt;

  if (p.username && p.username !== entry.username) data.username = p.username;

  if (p.kind === "COMMENT") {
    const replay =
      (p.eventId && entry.sourceEventIds.includes(p.eventId)) || (p.commentId && entry.firstCommentId === p.commentId);
    if (replay && !p.extraHandles) return "ignored";

    const text = p.text ?? "";
    const own = extractTaggedHandles(text, account.username);
    handles = union(handles, union(own, p.extraHandles ?? []));
    const noCommentYet = entry.firstCommentId === "";
    const previousPasses = !noCommentYet && commentPasses(rules, entry.firstCommentText).passed;
    // The comment that counts is the first one that satisfies the comment rule.
    if (noCommentYet || (!previousPasses && commentPasses(rules, text).passed)) {
      commentText = text;
      data.firstCommentId = p.commentId ?? "";
      data.firstCommentText = text;
      data.firstCommentAt = p.at;
    }
    data.commentCount =
      p.commentCount !== undefined ? Math.max(entry.commentCount, p.commentCount) : replay ? entry.commentCount : entry.commentCount + 1;
    if (p.eventId && !entry.sourceEventIds.includes(p.eventId)) {
      data.sourceEventIds = [...entry.sourceEventIds, p.eventId].slice(-MAX_SOURCE_EVENTS);
    }
    data.taggedUsernames = handles;
  } else {
    if (entry.mentionedAt) return "ignored";
    mentionedAt = p.at;
    data.mentionedAt = p.at;
    data.mentionEventId = p.eventId ?? null;
  }

  if (!isFrozen(entry)) {
    const evaluation = evaluateEntry(
      rules,
      {
        igUserId: entry.igUserId,
        username: p.username ?? entry.username,
        commentText,
        taggedUsernames: handles,
        mentionedAt,
        followResult: entry.followResult as FollowResult,
      },
      now
    );
    Object.assign(data, verdictData(evaluation));
  }

  await prisma.giveawayEntry.update({ where: { id: entry.id }, data });
  return "updated";
}

// ─── Follow sweep ─────────────────────────────────────────────────────────────

/** Ask Meta about entries waiting for a follow verdict (budgeted, throttled) and re-evaluate them. */
export async function sweepFollowChecks(
  giveaway: Pick<Giveaway, "id">,
  rules: GiveawayRules,
  account: CollectAccount,
  now: Date,
  budget = FOLLOW_BUDGET_PER_TICK
): Promise<number> {
  if (!rules.follow.required) return 0;
  const token = readAccessToken(account);
  if (!token.ok) return 0;

  // The due condition is in the query, so old UNVERIFIABLE entries (asked again
  // only after FOLLOW_RECHECK_MS) never crowd out the people nobody asked yet:
  // NOT_CHECKED first (oldest first), then the oldest due UNVERIFIABLE ones.
  const recheckBefore = new Date(now.getTime() - FOLLOW_RECHECK_MS);
  const phases: Array<Pick<Prisma.GiveawayEntryFindManyArgs, "where" | "orderBy">> = [
    {
      where: { giveawayId: giveaway.id, status: "PENDING_CHECK", followResult: "NOT_CHECKED" },
      orderBy: { createdAt: "asc" },
    },
    {
      where: {
        giveawayId: giveaway.id,
        status: "PENDING_CHECK",
        followResult: "UNVERIFIABLE",
        OR: [{ followCheckedAt: null }, { followCheckedAt: { lt: recheckBefore } }],
      },
      orderBy: { followCheckedAt: { sort: "asc", nulls: "first" } },
    },
  ];

  let checks = 0;
  for (const phase of phases) {
    if (checks >= budget) break;
    const candidates = await prisma.giveawayEntry.findMany({ ...phase, take: budget * 3 });
    for (const entry of candidates) {
      if (checks >= budget) break;
      if (isFrozen(entry) || !followCheckDue(entry, now)) continue;
      const result = await checkFollow(token.token, entry.igUserId);
      checks++;
      const evaluation = evaluateEntry(
        rules,
        {
          igUserId: entry.igUserId,
          username: entry.username,
          commentText: entry.firstCommentText,
          taggedUsernames: entry.taggedUsernames,
          mentionedAt: entry.mentionedAt,
          followResult: result,
        },
        now
      );
      await prisma.giveawayEntry.update({
        where: { id: entry.id },
        data: { followResult: result, followCheckedAt: now, ...verdictData(evaluation) },
      });
    }
  }
  return checks;
}

// ─── Counters ─────────────────────────────────────────────────────────────────

export async function refreshGiveawayCounters(giveawayId: string): Promise<{ entriesCount: number; eligibleCount: number }> {
  const [entriesCount, eligibleCount] = await Promise.all([
    prisma.giveawayEntry.count({ where: { giveawayId } }),
    prisma.giveawayEntry.count({ where: { giveawayId, status: "ELIGIBLE" } }),
  ]);
  await prisma.giveaway.update({ where: { id: giveawayId }, data: { entriesCount, eligibleCount } });
  return { entriesCount, eligibleCount };
}

// ─── Events ───────────────────────────────────────────────────────────────────

/** The post a COMMENT event belongs to: its own mediaId, or the ad's original post. */
export function commentMediaIds(event: { mediaId: string | null; rawPayload: unknown }): string[] {
  const ids: string[] = [];
  if (event.mediaId) ids.push(event.mediaId);
  const original = (event.rawPayload as { item?: { value?: { media?: { original_media_id?: unknown } } } } | null)?.item?.value?.media
    ?.original_media_id;
  if (typeof original === "string" && original) ids.push(original);
  return ids;
}

/** Late commits: rows stored this recently may still appear, so the idle cursor stays this far behind `now`. */
const CURSOR_LAG_MS = 60_000;

async function collectGiveaway(
  giveaway: Giveaway & { instagramAccount: CollectAccount },
  now: Date,
  sweepFollow = true
): Promise<Omit<CollectorSummary, "giveaways">> {
  const summary = { scanned: 0, created: 0, updated: 0, followChecks: 0 };
  const rules = parseRules(giveaway.rules);
  const ctx: CollectContext = {
    giveaway,
    rules,
    account: { instagramId: giveaway.instagramAccount.instagramId, username: giveaway.instagramAccount.username },
    now,
  };

  const cursor = giveaway.collectCursorAt
    ? {
        OR: [
          { createdAt: { gt: giveaway.collectCursorAt } },
          { createdAt: giveaway.collectCursorAt, id: { gt: giveaway.collectCursorId ?? "" } },
        ],
      }
    : {};
  // Account + type + createdAt range first (index friendly); the jsonb filter last.
  // Rows are read only up to `now`, so the high-water mark below is safe.
  const events = await prisma.instagramEvent.findMany({
    where: {
      workspaceId: giveaway.workspaceId,
      instagramAccountId: giveaway.instagramAccountId,
      eventType: { in: ["COMMENT", "STORY_MENTION"] },
      // An event cannot be stored before it happened (an hour of margin for clock skew).
      createdAt: { gte: new Date(giveaway.windowStart.getTime() - 3600_000), lte: now },
      AND: [
        cursor,
        {
          OR: [
            { eventType: "STORY_MENTION" },
            { mediaId: giveaway.mediaId },
            { rawPayload: { path: MEDIA_ID_PATH, equals: giveaway.mediaId } },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: COLLECT_BATCH,
  });

  for (const event of events) {
    summary.scanned++;
    const at = event.timestamp;
    if (at < giveaway.windowStart || at > giveaway.windowEnd) continue;
    if (event.eventType === "COMMENT" && !commentMediaIds(event).includes(giveaway.mediaId)) continue;
    const outcome = await recordParticipation(ctx, {
      igUserId: event.senderId,
      username: event.senderUsername,
      kind: event.eventType === "COMMENT" ? "COMMENT" : "MENTION",
      commentId: event.messageId,
      text: event.text,
      at,
      eventId: event.id,
    });
    if (outcome === "created") summary.created++;
    else if (outcome === "updated") summary.updated++;
  }

  if (events.length > 0) {
    const last = events[events.length - 1];
    await prisma.giveaway.update({ where: { id: giveaway.id }, data: { collectCursorAt: last.createdAt, collectCursorId: last.id } });
  } else {
    // Nothing matched: still move the high-water mark, or every tick would rescan
    // the same (growing) range. Never backwards.
    const mark = new Date(now.getTime() - CURSOR_LAG_MS);
    if (!giveaway.collectCursorAt || mark > giveaway.collectCursorAt) {
      await prisma.giveaway.update({ where: { id: giveaway.id }, data: { collectCursorAt: mark, collectCursorId: "" } });
    }
  }

  if (sweepFollow) summary.followChecks = await sweepFollowChecks(giveaway, rules, giveaway.instagramAccount, now);

  if (summary.created > 0 || summary.updated > 0 || summary.followChecks > 0) await refreshGiveawayCounters(giveaway.id);
  return summary;
}

// One collector at a time per process: the maintenance tick and a closing
// owner's final drain never overlap.
let running = false;
const LOCK_WAIT_MS = 120_000;

async function acquireCollectorLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (running) {
    if (Date.now() > deadline) throw new Error("Yig'uvchi band — keyinroq urinib ko'ring");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  running = true;
}

/**
 * Catch up on everything stored so far for one giveaway (before it is closed,
 * so the last minute of entries is not lost). Bounded; runs under the same
 * in-process guard as the maintenance tick, with a single follow-check round
 * at the end.
 */
export async function drainGiveaway(giveawayId: string, now: Date = new Date()): Promise<void> {
  await acquireCollectorLock();
  try {
    let last: (Giveaway & { instagramAccount: CollectAccount }) | null = null;
    for (let round = 0; round < 40; round++) {
      const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { instagramAccount: true } });
      if (!giveaway || giveaway.status !== "ACTIVE") return;
      last = giveaway as Giveaway & { instagramAccount: CollectAccount };
      const part = await collectGiveaway(last, now, false);
      if (part.scanned < COLLECT_BATCH) break;
    }
    if (last) {
      const followChecks = await sweepFollowChecks(last, parseRules(last.rules), last.instagramAccount, now);
      if (followChecks > 0) await refreshGiveawayCounters(giveawayId);
    }
  } finally {
    running = false;
  }
}

/** One pass over every ACTIVE giveaway. Never throws; a failing giveaway is logged and the next one runs. */
export async function runGiveawayCollector(now: Date = new Date()): Promise<CollectorSummary> {
  const total: CollectorSummary = { giveaways: 0, scanned: 0, created: 0, updated: 0, followChecks: 0 };
  if (!isEngagementEnabled() || running) return total;
  running = true;
  try {
    const giveaways = await prisma.giveaway.findMany({
      where: { status: "ACTIVE" },
      include: { instagramAccount: true },
    });
    for (const giveaway of giveaways) {
      try {
        const part = await collectGiveaway(giveaway as Giveaway & { instagramAccount: CollectAccount }, now);
        total.giveaways++;
        total.scanned += part.scanned;
        total.created += part.created;
        total.updated += part.updated;
        total.followChecks += part.followChecks;
      } catch (error) {
        console.error(`[Engagement] collector failed for giveaway ${giveaway.id}:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    running = false;
  }
  return total;
}
