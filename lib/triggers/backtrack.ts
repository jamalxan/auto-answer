/**
 * Backtrack (TZ 11): "send to earlier comments too".
 *
 * One TriggerBacktrackRun scans a campaign's posts back N days (1..7) and
 * queues the comments the campaign would have answered, as ordinary COMMENT
 * events marked with the run id — the comment handler then treats them like
 * live ones (and only lets this campaign answer them).
 *
 * Skipped, and counted on the run:
 *   - expired:   older than Meta's 7-day private-reply limit (minus a margin
 *                for queue delays) — never sent;
 *   - no match:  this campaign's keywords / intents / posts do not match;
 *   - duplicate: already an event for the comment (webhook, earlier run) or
 *                already answered privately by a production campaign.
 * The account's own comments are left out silently.
 *
 * Bounded so a viral account cannot flood the API or the queue: at most
 * BACKTRACK_MAX_POSTS posts ("any post" campaigns: the latest ones),
 * BACKTRACK_COMMENTS_PER_POST comments per post, BACKTRACK_MAX_QUEUED queued
 * per run (the run says so when it hits the cap).
 *
 * startBacktrack validates, creates the RUNNING run and returns its id right
 * away; the scan continues in the background of this (long-running) server
 * process and records its progress on the run after every post — the UI polls
 * the runs. A run still RUNNING after STALE_RUN_MS is treated as crashed (the
 * process restarted mid-scan) and marked FAILED when runs are listed or the
 * next one starts. One run per campaign at a time: a second start gets a
 * BacktrackConflictError (HTTP 409).
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { getRecentMediaComments, getUserMedia, type InstagramComment } from "@/lib/meta/client";
import { isTriggerEngineEnabled } from "./config";
import { readAccessToken } from "./delivery";
import { classifySendError } from "./errors";
import { storeEvent } from "./ingest";
import { selectCommentCampaign } from "./matching";
import { notLogOnlyEventWhere, type NormalizedInstagramEvent } from "./normalize";
import { enqueueEvent } from "./queue";

export const BACKTRACK_MAX_DAYS = 7;
export const BACKTRACK_MAX_POSTS = 25;
export const BACKTRACK_COMMENTS_PER_POST = 300;
export const BACKTRACK_MAX_QUEUED = 500;
/** Queue delays (rate limit waits up to ~1h) must not push a send past day 7. */
export const BACKTRACK_EXPIRY_MARGIN_MS = 2 * 3600_000;
const PRIVATE_REPLY_LIMIT_MS = 7 * 24 * 3600_000;
const STALE_RUN_MS = 30 * 60_000;
const STALE_RUN_ERROR = "Jarayon to'xtab qolgan (server qayta ishga tushgan bo'lishi mumkin) — qaytadan boshlang.";

/** A backtrack is already running for the campaign (HTTP 409). */
export class BacktrackConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("Bu kampaniya uchun backtrack allaqachon ishlayapti — tugashini kuting.");
  }
}

/** RUNNING runs older than STALE_RUN_MS never finish: mark them FAILED. */
export async function expireStaleBacktrackRuns(campaignId: string, now: Date = new Date()) {
  await prisma.triggerBacktrackRun.updateMany({
    where: { campaignId, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
    data: { status: "FAILED", error: STALE_RUN_ERROR, finishedAt: now },
  });
}

export function clampBacktrackDays(days: number): number {
  const n = Number.isFinite(days) ? Math.floor(days) : 1;
  return Math.min(BACKTRACK_MAX_DAYS, Math.max(1, n));
}

// ─── Pure filter ──────────────────────────────────────────────────────────────

export type BacktrackVerdict = "queue" | "outside_window" | "expired" | "own" | "no_author" | "no_match" | "duplicate";

export function classifyBacktrackComment(input: {
  comment: Pick<InstagramComment, "id" | "timestamp" | "from">;
  now: Date;
  sinceMs: number;
  ownInstagramId: string;
  matches: boolean;
  alreadyKnown: boolean;
}): BacktrackVerdict {
  const at = input.comment.timestamp ? Date.parse(input.comment.timestamp) : NaN;
  // Without a timestamp the 7-day rule cannot be checked: treat as expired.
  if (Number.isNaN(at)) return "expired";
  if (at < input.sinceMs) return "outside_window";
  if (input.now.getTime() - at >= PRIVATE_REPLY_LIMIT_MS - BACKTRACK_EXPIRY_MARGIN_MS) return "expired";
  const authorId = input.comment.from?.id;
  if (!authorId) return "no_author";
  if (authorId === input.ownInstagramId) return "own";
  if (!input.matches) return "no_match";
  if (input.alreadyKnown) return "duplicate";
  return "queue";
}

// ─── Run ──────────────────────────────────────────────────────────────────────

interface Counters {
  scanned: number;
  queued: number;
  skippedDuplicate: number;
  skippedNoMatch: number;
  skippedExpired: number;
}

/**
 * Start a scan for one campaign and return without waiting for it.
 * Validation problems throw an Error with an Uzbek message for the UI (a run
 * already in progress: BacktrackConflictError); everything after the run row
 * exists is recorded on the run (FAILED + error) instead of thrown.
 */
export async function startBacktrack(
  workspaceId: string,
  campaignId: string,
  days: number
): Promise<{ runId: string }> {
  if (!isTriggerEngineEnabled()) throw new Error("Trigger engine o'chirilgan (TRIGGER_ENGINE_DISABLED).");

  const campaign = await prisma.triggerCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: { instagramAccount: true },
  });
  if (!campaign) throw new Error("Kampaniya topilmadi.");
  if (campaign.triggerType !== "COMMENT") throw new Error("Backtrack faqat comment kampaniyalari uchun.");
  if (!campaign.active) throw new Error("Avval kampaniyani yoqing — o'chirilgan kampaniya izohlarga javob bermaydi.");

  await expireStaleBacktrackRuns(campaignId);
  const running = await prisma.triggerBacktrackRun.findFirst({
    where: { campaignId, status: "RUNNING" },
    select: { id: true },
  });
  if (running) throw new BacktrackConflictError();

  const clampedDays = clampBacktrackDays(days);
  const run = await prisma.triggerBacktrackRun.create({
    data: { workspaceId, campaignId, days: clampedDays, status: "RUNNING" },
  });

  // Two starts at the same moment can both pass the check above. Both then see
  // the same RUNNING rows, and only the oldest one goes ahead.
  const first = await prisma.triggerBacktrackRun.findFirst({
    where: { campaignId, status: "RUNNING" },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (first && first.id !== run.id) {
    await prisma.triggerBacktrackRun.delete({ where: { id: run.id } }).catch(() => {});
    throw new BacktrackConflictError();
  }

  // Not awaited: the scan can take minutes; its outcome lands on the run.
  void runScan(run.id, campaign, clampedDays);
  return { runId: run.id };
}

/** The scan with its outcome recorded on the run. Never throws. */
async function runScan(runId: string, campaign: CampaignWithAccount, days: number): Promise<void> {
  try {
    const notice = await scan(runId, campaign, days);
    await prisma.triggerBacktrackRun.update({
      where: { id: runId },
      data: { status: "DONE", error: notice, finishedAt: new Date() },
    });
  } catch (error) {
    const failure = classifySendError(error);
    const reason = error instanceof BacktrackError ? error.message : failure.userMessage;
    console.error(`[Trigger Engine] backtrack ${runId} failed:`, failure.technical);
    await prisma.triggerBacktrackRun
      .update({
        where: { id: runId },
        data: { status: "FAILED", error: `Backtrack to'xtadi: ${reason}`.slice(0, 500), finishedAt: new Date() },
      })
      .catch(() => {});
  }
}

type CampaignWithAccount = Prisma.TriggerCampaignGetPayload<{ include: { instagramAccount: true } }>;

/** A scan problem with a message already written for the admin. */
class BacktrackError extends Error {}

/** Returns a notice for the run (cap reached, unreadable posts) or null. Throws on fatal errors. */
async function scan(runId: string, campaign: CampaignWithAccount, days: number): Promise<string | null> {
  const account = campaign.instagramAccount;
  const token = readAccessToken(account);
  if (!token.ok) throw new BacktrackError(token.failure.userMessage);

  const now = new Date();
  const sinceMs = now.getTime() - days * 24 * 3600_000;
  const mediaIds =
    campaign.mediaScope === "SPECIFIC"
      ? campaign.mediaIds.slice(0, BACKTRACK_MAX_POSTS)
      : (await getUserMedia(token.token, BACKTRACK_MAX_POSTS)).map((media) => media.id);

  const counters: Counters = { scanned: 0, queued: 0, skippedDuplicate: 0, skippedNoMatch: 0, skippedExpired: 0 };
  const unreadable: string[] = [];
  let capped = false;

  for (const mediaId of mediaIds) {
    if (capped) break;
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments(token.token, mediaId, sinceMs, BACKTRACK_COMMENTS_PER_POST);
    } catch (error) {
      const failure = classifySendError(error);
      if (failure.kind === "token") throw error;
      unreadable.push(mediaId);
      console.error(`[Trigger Engine] backtrack ${runId}: post ${mediaId} unreadable:`, failure.technical);
      continue;
    }

    const ids = comments.map((c) => c.id);
    const [events, answered] = await Promise.all([
      prisma.instagramEvent.findMany({
        where: { instagramAccountId: account.id, messageId: { in: ids }, ...notLogOnlyEventWhere() },
        select: { messageId: true },
      }),
      prisma.dmLog.findMany({
        where: { commentId: { in: ids }, status: "SENT" },
        select: { commentId: true },
      }),
    ]);
    const known = new Set([...events.map((e) => e.messageId), ...answered.map((d) => d.commentId)]);

    for (const comment of comments) {
      const verdict = classifyBacktrackComment({
        comment,
        now,
        sinceMs,
        ownInstagramId: account.instagramId,
        matches: selectCommentCampaign([campaign], { mediaId, text: comment.text ?? "" }).campaign !== null,
        alreadyKnown: known.has(comment.id),
      });
      if (verdict === "outside_window" || verdict === "own") continue;
      counters.scanned++;
      if (verdict === "expired") counters.skippedExpired++;
      else if (verdict === "no_match" || verdict === "no_author") counters.skippedNoMatch++;
      else if (verdict === "duplicate") counters.skippedDuplicate++;
      else {
        if (counters.queued >= BACKTRACK_MAX_QUEUED) {
          capped = true;
          break;
        }
        const queued = await queueComment(runId, account, mediaId, comment);
        if (queued) counters.queued++;
        else counters.skippedDuplicate++;
      }
    }

    await prisma.triggerBacktrackRun.update({ where: { id: runId }, data: { ...counters } });
  }

  if (mediaIds.length > 0 && unreadable.length === mediaIds.length) {
    throw new BacktrackError("Postlarning izohlarini o'qib bo'lmadi.");
  }
  const notices: string[] = [];
  if (capped) notices.push(`Limit: bitta backtrack ko'pi bilan ${BACKTRACK_MAX_QUEUED} ta izohni navbatga qo'shadi.`);
  if (unreadable.length > 0) notices.push(`${unreadable.length} ta post izohlarini o'qib bo'lmadi.`);
  return notices.length > 0 ? notices.join(" ") : null;
}

async function queueComment(
  runId: string,
  account: { id: string; workspaceId: string; instagramId: string },
  mediaId: string,
  comment: InstagramComment
): Promise<boolean> {
  const event: NormalizedInstagramEvent = {
    type: "COMMENT",
    instagramAccountId: account.instagramId,
    senderId: comment.from!.id,
    senderUsername: comment.from?.username,
    messageId: comment.id,
    mediaId,
    text: comment.text?.trim() ?? "",
    hasAttachment: false,
    timestamp: new Date(comment.timestamp),
    raw: { source: "backtrack", runId, comment: { id: comment.id, text: comment.text, timestamp: comment.timestamp, from: comment.from } },
  };
  // A webhook for the same comment may land between the check and here: the
  // unique (account, comment id) row decides, exactly as for webhooks.
  const eventId = await storeEvent(account, event, { backtrackRunId: runId });
  if (!eventId) return false;
  await enqueueEvent(eventId).catch((error) => {
    console.error("[Trigger Engine] backtrack enqueue failed, left for the sweep:", error instanceof Error ? error.message : error);
  });
  return true;
}
