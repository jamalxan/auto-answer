/**
 * Backfill: comments that were written before the giveaway was set up (or
 * while the webhook was off) are read from the Graph API and written
 * straight into GiveawayEntry. No InstagramEvent rows are created, so a
 * Comment 2.0 campaign on the same post is never re-triggered by them.
 *
 * Bounded: at most BACKFILL_CAP comments from windowStart on (Meta returns
 * them newest first; the post's own recent comments only). One entry per
 * person, built from all of the person's comments in one write, so running it
 * again changes nothing. The job never throws raw: the outcome is on the
 * giveaway row (backfillStatus RUNNING / DONE / FAILED + backfillError).
 */

import { prisma } from "@/lib/db/client";
import { getRecentMediaComments, type InstagramComment } from "@/lib/meta/client";
import { readAccessToken } from "@/lib/triggers/delivery";
import { BACKFILL_CAP, isEngagementEnabled } from "../config";
import { conflict, notFound } from "../errors";
import { enqueueEngagement, GIVEAWAY_BACKFILL_JOB, safeJobId } from "../queue";
import { recordParticipation, refreshGiveawayCounters, type CollectContext } from "./collector";
import { commentPasses, extractTaggedHandles, parseRules, type GiveawayRules } from "./rules";

/** A RUNNING backfill with no progress for this long is dead (worker restart / crashed job). */
export const BACKFILL_STALE_MS = 10 * 60_000;

export interface BackfillResult {
  scanned: number;
  entries: number;
  capped: boolean;
}

interface PersonComments {
  igUserId: string;
  username: string | null;
  comments: Array<{ id: string; text: string; at: Date }>;
}

/** Mark RUNNING and hand the scan to the worker (inline when there is no queue). */
export async function startBackfill(workspaceId: string, giveawayId: string, now: Date = new Date()): Promise<{ status: "RUNNING" }> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId } });
  if (!giveaway) throw notFound("Giveaway topilmadi");
  if (giveaway.status !== "DRAFT" && giveaway.status !== "ACTIVE") throw conflict("Izohlarni faqat qoralama yoki faol giveaway uchun yuklash mumkin");
  // updatedAt moves with every progress write, so an old RUNNING row is a dead run: allow a restart.
  if (giveaway.backfillStatus === "RUNNING" && now.getTime() - giveaway.updatedAt.getTime() < BACKFILL_STALE_MS) {
    throw conflict("Izohlarni yuklash allaqachon davom etmoqda");
  }

  await prisma.giveaway.update({
    where: { id: giveawayId },
    data: { backfillStatus: "RUNNING", backfillScanned: 0, backfillError: null },
  });
  const queued = await enqueueEngagement(
    GIVEAWAY_BACKFILL_JOB,
    { workspaceId, giveawayId },
    { jobId: safeJobId(`giveaway-backfill_${giveawayId}_${Date.now()}`), attempts: 1 }
  );
  if (!queued) void runBackfill(workspaceId, giveawayId).catch(() => {});
  return { status: "RUNNING" };
}

/** Worker `failed` handler: a backfill job that died must not stay RUNNING. */
export async function failBackfill(giveawayId: string, message: string) {
  await prisma.giveaway
    .updateMany({ where: { id: giveawayId, backfillStatus: "RUNNING" }, data: { backfillStatus: "FAILED", backfillError: message.slice(0, 500) } })
    .catch(() => {});
}

async function fail(giveawayId: string, message: string) {
  await prisma.giveaway
    .update({ where: { id: giveawayId }, data: { backfillStatus: "FAILED", backfillError: message.slice(0, 500) } })
    .catch(() => {});
}

function group(comments: InstagramComment[], giveaway: { windowStart: Date; windowEnd: Date }, ownId: string): Map<string, PersonComments> {
  const people = new Map<string, PersonComments>();
  for (const comment of comments) {
    const author = comment.from?.id;
    const at = comment.timestamp ? new Date(comment.timestamp) : null;
    if (!author || author === ownId || !at || Number.isNaN(at.getTime())) continue;
    if (at < giveaway.windowStart || at > giveaway.windowEnd) continue;
    const person = people.get(author) ?? { igUserId: author, username: comment.from?.username ?? null, comments: [] };
    person.comments.push({ id: comment.id, text: comment.text ?? "", at });
    people.set(author, person);
  }
  return people;
}

/** The comment that counts: the earliest one satisfying the comment rule, else the earliest. */
function pickComment(rules: GiveawayRules, person: PersonComments) {
  const sorted = [...person.comments].sort((a, b) => a.at.getTime() - b.at.getTime());
  return sorted.find((c) => commentPasses(rules, c.text).passed) ?? sorted[0];
}

/** The worker job. Resolves with the outcome; failures land on the giveaway row. */
export async function runBackfill(workspaceId: string, giveawayId: string, now: Date = new Date()): Promise<BackfillResult | null> {
  if (!isEngagementEnabled()) return null;
  try {
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, workspaceId }, include: { instagramAccount: true } });
    if (!giveaway) return null;
    const account = giveaway.instagramAccount;
    const token = readAccessToken(account);
    if (!token.ok) {
      await fail(giveawayId, token.failure.userMessage);
      return null;
    }

    const rules = parseRules(giveaway.rules);
    const comments = await getRecentMediaComments(token.token, giveaway.mediaId, giveaway.windowStart.getTime(), BACKFILL_CAP);
    // Progress write (also moves updatedAt, the staleness clock of startBackfill).
    await prisma.giveaway.update({ where: { id: giveawayId }, data: { backfillScanned: comments.length } });
    const people = group(comments, giveaway, account.instagramId);
    const ctx: CollectContext = { giveaway, rules, account: { instagramId: account.instagramId, username: account.username }, now };

    let entries = 0;
    let handled = 0;
    for (const person of people.values()) {
      const chosen = pickComment(rules, person);
      const handles = [...new Set(person.comments.flatMap((c) => extractTaggedHandles(c.text, account.username)))];
      const outcome = await recordParticipation(ctx, {
        igUserId: person.igUserId,
        username: person.username,
        kind: "COMMENT",
        commentId: chosen.id,
        text: chosen.text,
        at: chosen.at,
        eventId: null,
        extraHandles: handles,
        commentCount: person.comments.length,
      });
      if (outcome !== "ignored") entries++;
      if (++handled % 200 === 0) await prisma.giveaway.update({ where: { id: giveawayId }, data: { backfillScanned: comments.length } });
    }

    const capped = comments.length >= BACKFILL_CAP;
    await refreshGiveawayCounters(giveawayId);
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: {
        backfillStatus: "DONE",
        backfillScanned: comments.length,
        backfillError: capped ? `${BACKFILL_CAP} ta izoh chegarasiga yetildi — eski izohlar yuklanmadi` : null,
      },
    });
    return { scanned: comments.length, entries, capped };
  } catch (error) {
    console.error(`[Engagement] backfill failed for giveaway ${giveawayId}:`, error instanceof Error ? error.message : error);
    await fail(giveawayId, `Izohlarni yuklab bo'lmadi: ${error instanceof Error ? error.message : "noma'lum xato"}`);
    return null;
  }
}
