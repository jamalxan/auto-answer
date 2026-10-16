/**
 * ETAP 9.3 — referral attribution. A keyset scan over InstagramEvent rows that
 * carry an `rf_<code>` ref (ig.me link, stored by the trigger engine's
 * normaliser since ETAP 3) turns each first-time friend into a PENDING
 * ReferralEvent:
 *
 *   - the scan position lives in CrmSyncCursor (source "engagement:referral"),
 *     seeded at "now" on the first run — history is never rewarded;
 *   - only accounts with an ACTIVE program count, and only events at or after
 *     the program's activation time;
 *   - unknown codes are ignored; the code is case-insensitive (normalised upper);
 *   - `@@unique(programId, refereeIgUserId)`: the first ref wins, later ones
 *     are ignored (the code's `lastSharedAt` still moves);
 *   - fraud flags are computed once (fraud.ts); flagged events wait for review.
 *
 * Idempotent: a re-run over the same events finds the unique row and skips it.
 */

import type { InstagramEvent, ReferralProgram } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/crm/errors";
import { isEngagementEnabled } from "../config";
import { codeFromRef } from "./codes";
import { computeFraudFlags } from "./fraud";
import { activatedAtOf } from "./reward";

export const REFERRAL_CURSOR_SOURCE = "engagement:referral";
export const ATTRIBUTION_BATCH = 500;
const DAY_MS = 24 * 3600_000;
/** An idle cursor stays this far behind `now` (late commits). */
const CURSOR_LAG_MS = 60_000;

export interface AttributionResult {
  scanned: number;
  created: number;
  flagged: number;
  ignored: number;
}

interface Cursor {
  at: Date;
  id: string | null;
}

async function readCursor(now: Date): Promise<Cursor> {
  const row = await prisma.crmSyncCursor.findUnique({ where: { source: REFERRAL_CURSOR_SOURCE } });
  if (row) return { at: row.cursorAt, id: row.cursorId };
  // First run: start at "now" — referrals that predate the engine are history.
  await prisma.crmSyncCursor.upsert({
    where: { source: REFERRAL_CURSOR_SOURCE },
    create: { source: REFERRAL_CURSOR_SOURCE, cursorAt: now, cursorId: null, createdAt: now },
    update: {},
  });
  return { at: now, id: null };
}

async function writeCursor(cursor: Cursor): Promise<void> {
  await prisma.crmSyncCursor.upsert({
    where: { source: REFERRAL_CURSOR_SOURCE },
    create: { source: REFERRAL_CURSOR_SOURCE, cursorAt: cursor.at, cursorId: cursor.id },
    update: { cursorAt: cursor.at, cursorId: cursor.id },
  });
}

function afterCursor(cursor: Cursor, bound: Date): Record<string, unknown> {
  const upper = { createdAt: { lte: bound } };
  if (!cursor.id) return { AND: [{ createdAt: { gt: cursor.at } }, upper] };
  return { AND: [{ OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id } }] }, upper] };
}

export async function runReferralAttribution(now: Date = new Date()): Promise<AttributionResult> {
  const result: AttributionResult = { scanned: 0, created: 0, flagged: 0, ignored: 0 };
  if (!isEngagementEnabled()) return result;

  const cursor = await readCursor(now);
  const events = await prisma.instagramEvent.findMany({
    where: { ref: { startsWith: "rf_", mode: "insensitive" }, ...afterCursor(cursor, now) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: ATTRIBUTION_BATCH,
  });
  if (events.length === 0) {
    // Nothing matched: still advance, or every sweep would rescan an ever-growing range.
    // Rows are read only up to `now`; the lag leaves room for a late commit. Never backwards.
    const mark = new Date(now.getTime() - CURSOR_LAG_MS);
    if (mark > cursor.at) await writeCursor({ at: mark, id: null });
    return result;
  }

  const accountIds = [...new Set(events.map((event) => event.instagramAccountId))];
  const programs = await prisma.referralProgram.findMany({ where: { instagramAccountId: { in: accountIds }, active: true } });
  const programByAccount = new Map(programs.map((program) => [program.instagramAccountId, program]));

  for (const event of events) {
    result.scanned++;
    const program = programByAccount.get(event.instagramAccountId);
    const outcome = program ? await attributeEvent(event, program) : "ignored";
    if (outcome === "ignored") result.ignored++;
    else {
      result.created++;
      if (outcome === "flagged") result.flagged++;
    }
  }

  const last = events[events.length - 1];
  await writeCursor({ at: last.createdAt, id: last.id });
  return result;
}

type Outcome = "created" | "flagged" | "ignored";

async function attributeEvent(event: InstagramEvent, program: ReferralProgram): Promise<Outcome> {
  const code = codeFromRef(event.ref);
  if (!code) return "ignored";
  // History before the activation is never rewarded.
  if (event.timestamp < activatedAtOf(program)) return "ignored";

  const codeRow = await prisma.referralCode.findUnique({
    where: { instagramAccountId_code: { instagramAccountId: event.instagramAccountId, code } },
  });
  if (!codeRow || codeRow.programId !== program.id) return "ignored";

  const refereeIgUserId = event.senderId;
  // The business's own echoes are not friends.
  const account = await prisma.instagramAccount.findUnique({ where: { id: event.instagramAccountId }, select: { instagramId: true } });
  if (account?.instagramId === refereeIgUserId) return "ignored";

  if (!codeRow.lastSharedAt || codeRow.lastSharedAt < event.timestamp) {
    await prisma.referralCode.update({ where: { id: codeRow.id }, data: { lastSharedAt: event.timestamp } });
  }

  const existing = await prisma.referralEvent.findUnique({
    where: { programId_refereeIgUserId: { programId: program.id, refereeIgUserId } },
  });
  if (existing) return "ignored";

  const [referrer, referee, earlier, burst] = await Promise.all([
    prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: event.instagramAccountId, igUserId: codeRow.igUserId } },
      select: { id: true, phoneE164: true },
    }),
    prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: event.instagramAccountId, igUserId: refereeIgUserId } },
      select: { id: true, phoneE164: true },
    }),
    // The (instagramAccountId, senderId, timestamp) index; the carrying event itself does not count.
    prisma.instagramEvent.findFirst({
      where: {
        instagramAccountId: event.instagramAccountId,
        senderId: refereeIgUserId,
        timestamp: { lt: event.timestamp },
        id: { not: event.id },
      },
      select: { id: true },
    }),
    prisma.referralEvent.count({
      where: {
        programId: program.id,
        referrerIgUserId: codeRow.igUserId,
        createdAt: { gte: new Date(event.timestamp.getTime() - DAY_MS), lte: event.timestamp },
      },
    }),
  ]);

  const flags = computeFraudFlags({
    referrerIgUserId: codeRow.igUserId,
    refereeIgUserId,
    referrerPhone: referrer?.phoneE164 ?? null,
    refereePhone: referee?.phoneE164 ?? null,
    referrerEventsIn24h: burst + 1,
    burstLimitPerDay: program.burstLimitPerDay,
    refereeKnownBefore: Boolean(earlier),
  });

  try {
    await prisma.referralEvent.create({
      data: {
        programId: program.id,
        workspaceId: program.workspaceId,
        codeId: codeRow.id,
        referrerIgUserId: codeRow.igUserId,
        referrerContactId: referrer?.id ?? codeRow.contactId ?? null,
        refereeIgUserId,
        refereeContactId: referee?.id ?? null,
        sourceEventId: event.id,
        status: "PENDING",
        fraudFlags: flags,
        // "When it happened": the burst window counts events by this time.
        createdAt: event.timestamp,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return "ignored";
    throw error;
  }
  return flags.length > 0 ? "flagged" : "created";
}
