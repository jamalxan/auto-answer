/**
 * ETAP 9.3 — the referral reward. Runs once per event: the status flip
 * QUALIFIED → REWARDED (with `rewardedAt`) is an `updateMany` claim, so a
 * double execution (two ticks, a listener racing the sweep) does the work in
 * exactly one of them. The tag and the points are idempotent on their own;
 * the Telegram message and the DMs are not, which is why the claim comes first.
 *
 * Every side effect runs in its own try/catch, so one failing step never
 * hides the others; what happened (or failed) is written to `rewardSnapshot`.
 * The two idempotent steps carry completion flags (`tagDone`, `pointsDone`):
 * the qualification sweep re-drives a REWARDED event whose snapshot is missing
 * or lacks them (redriveRewardSideEffects) and re-runs ONLY the tag and the
 * points — never the Telegram message or the DMs.
 *
 * What is done (and recorded in `rewardSnapshot`):
 *   tag       rewardRules.tagSlug → the referrer's CRM contact (origin AUTOMATION, sourceRef "referral:<eventId>")
 *   points    rewardRules.points, else the workspace rule "referral_qualified"
 *   telegram  rewardRules.telegramOwner → notifyWorkspaceChats
 *   DM        rewardRules.dmTemplate to the referrer, ONLY while their 24h window is open
 *             (else the snapshot says "oyna yopiq — DM yuborilmadi"); refereeDmTemplate likewise to the friend
 */

import { z } from "zod";
import type { InstagramAccount, ReferralEvent, ReferralProgram, ReferralQualifier } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { isBroadcastWindowOpen } from "@/lib/crm/broadcast-policy";
import { tagSlug } from "@/lib/crm/defaults";
import { ensureTag, addTag } from "@/lib/crm/tags";
import { readAccessToken, sendGuarded } from "@/lib/triggers/delivery";
import { awardPoints } from "../points";
import { isBlocked } from "./fraud";

// ─── Reward rules (stored in ReferralProgram.rewardRules) ─────────────────────

export const rewardRulesSchema = z.object({
  tagSlug: z.string().trim().max(40, "Teg 40 belgidan oshmasin").optional(),
  points: z
    .number({ message: "Ball son bo'lishi kerak" })
    .int("Ball butun son bo'lsin")
    .min(0, "Ball 0 dan kam bo'lmasin")
    .max(1000, "Ball 1000 dan oshmasin")
    .optional(),
  telegramOwner: z.boolean().default(false),
  dmTemplate: z.string().trim().max(500, "Xabar 500 belgidan oshmasin").optional(),
  refereeDmTemplate: z.string().trim().max(500, "Xabar 500 belgidan oshmasin").optional(),
});
export type RewardRules = z.infer<typeof rewardRulesSchema>;

/** Internal marker kept inside the rewardRules JSON: when the program was (last) switched on. */
export const ACTIVATED_KEY = "_activatedAt";

/** Tolerant read of the stored JSON (bad / missing fields fall back to "nothing to do"). */
export function parseRewardRules(value: unknown): RewardRules {
  const parsed = rewardRulesSchema.safeParse(value && typeof value === "object" && !Array.isArray(value) ? value : {});
  if (parsed.success) return parsed.data;
  return { telegramOwner: false };
}

/** Events before this instant are history and never rewarded. */
export function activatedAtOf(program: Pick<ReferralProgram, "rewardRules" | "createdAt">): Date {
  const raw = program.rewardRules && typeof program.rewardRules === "object" ? (program.rewardRules as Record<string, unknown>)[ACTIVATED_KEY] : null;
  if (typeof raw === "string") {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return program.createdAt;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export const WINDOW_CLOSED_NOTE = "oyna yopiq — DM yuborilmadi";

export interface DmOutcome {
  sent: boolean;
  reason?: string;
}

export interface RewardSnapshot {
  at: string;
  /** Idempotent steps finished (false = threw; the sweep tries again). */
  tagDone?: boolean;
  pointsDone?: boolean;
  /** Step errors, by step name. */
  errors?: Record<string, string>;
  redrivenAt?: string;
  referrerContactId: string | null;
  tag: { slug: string; changed: boolean } | { skipped: string } | null;
  points: { awarded: boolean; points: number; skipped?: string } | null;
  telegram: { delivered: number } | { skipped: string } | null;
  dm: DmOutcome | null;
  refereeDm: DmOutcome | null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Owner Telegram wording per qualifier. */
export function referralTelegramText(qualifier: ReferralQualifier, who: string, friend: string, points: number | null): string {
  const action =
    qualifier === "LEAD" ? "lead qoldirdi" : qualifier === "PURCHASE" ? "xarid qildi" : "birinchi xabarini yozdi";
  return `<b>Referral</b>: ${escapeHtml(who)} taklif qilgan ${escapeHtml(friend)} ${action}.${points ? ` Ball: +${points}.` : ""}`;
}

function errorText(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, 300);
}

function render(template: string, name: string): string {
  return template.replace(/\{name\}/g, name).slice(0, 1000);
}

type Person = { name: string | null; username: string | null };

function displayName(person: Person | null | undefined, fallback: string): string {
  return person?.name?.trim() || (person?.username ? `@${person.username}` : "") || fallback;
}

async function sendOne(
  workspaceId: string,
  account: InstagramAccount,
  igUserId: string,
  contact: { lastInboundAt: Date | null; optedOutAt: Date | null } | null,
  text: string,
  now: Date
): Promise<DmOutcome> {
  if (!contact) return { sent: false, reason: "kontakt topilmadi — DM yuborilmadi" };
  if (contact.optedOutAt) return { sent: false, reason: "obunani bekor qilgan — DM yuborilmadi" };
  if (!isBroadcastWindowOpen(contact.lastInboundAt, now)) return { sent: false, reason: WINDOW_CLOSED_NOTE };
  const token = readAccessToken(account);
  if (!token.ok) return { sent: false, reason: token.failure.userMessage };
  const result = await sendGuarded(workspaceId, account, () => sendDirectMessage(token.token, account.instagramId, igUserId, text));
  if (result.ok) return { sent: true };
  return { sent: false, reason: result.skipped ? result.error : result.failure.userMessage };
}

// ─── Reward ───────────────────────────────────────────────────────────────────

export type RewardOutcome = { rewarded: true; snapshot: RewardSnapshot } | { rewarded: false; reason: string };

/** Rewards one QUALIFIED event; safe to call any number of times. */
export async function rewardReferralEvent(eventId: string, now: Date = new Date()): Promise<RewardOutcome> {
  const event = await prisma.referralEvent.findUnique({ where: { id: eventId } });
  if (!event) return { rewarded: false, reason: "not_found" };
  if (event.status !== "QUALIFIED" || event.rewardedAt) return { rewarded: false, reason: "not_qualified" };
  if (isBlocked(event)) return { rewarded: false, reason: "awaiting_review" };

  const program = await prisma.referralProgram.findUnique({ where: { id: event.programId } });
  if (!program) return { rewarded: false, reason: "no_program" };

  const claim = await prisma.referralEvent.updateMany({
    where: { id: event.id, status: "QUALIFIED", rewardedAt: null },
    data: { status: "REWARDED", rewardedAt: now },
  });
  if (claim.count === 0) return { rewarded: false, reason: "already_claimed" };

  const snapshot = await applyReward(event, program, now);
  try {
    await prisma.referralEvent.update({ where: { id: event.id }, data: { rewardSnapshot: JSON.parse(JSON.stringify(snapshot)) } });
  } catch (error) {
    // The sweep sees a REWARDED event without a snapshot and re-drives the idempotent steps.
    console.error("[Engagement] reward snapshot not saved:", error instanceof Error ? error.message : error);
  }
  return { rewarded: true, snapshot };
}

type Contact = Awaited<ReturnType<typeof prisma.crmContact.findFirst>>;

async function loadParties(event: ReferralEvent, program: ReferralProgram): Promise<{ referrer: Contact; referee: Contact }> {
  const workspaceId = event.workspaceId;
  const referrer = event.referrerContactId
    ? await prisma.crmContact.findFirst({ where: { id: event.referrerContactId, workspaceId } })
    : await prisma.crmContact.findUnique({
        where: { instagramAccountId_igUserId: { instagramAccountId: program.instagramAccountId, igUserId: event.referrerIgUserId } },
      });
  const referee = event.refereeContactId
    ? await prisma.crmContact.findFirst({ where: { id: event.refereeContactId, workspaceId } })
    : await prisma.crmContact.findUnique({
        where: { instagramAccountId_igUserId: { instagramAccountId: program.instagramAccountId, igUserId: event.refereeIgUserId } },
      });
  return { referrer, referee };
}

/** Idempotent: ensureTag + addTag (sourceRef "referral:<id>"). `done` is false only when it threw. */
async function tagStep(rules: RewardRules, event: ReferralEvent, referrer: Contact): Promise<{ tag: RewardSnapshot["tag"]; done: boolean; error?: string }> {
  if (!rules.tagSlug) return { tag: null, done: true };
  if (!referrer) return { tag: { skipped: "taklif qiluvchi kontakti topilmadi" }, done: true };
  try {
    const slug = tagSlug(rules.tagSlug);
    if (!slug) return { tag: { skipped: "teg nomi yaroqsiz" }, done: true };
    const tag = await ensureTag(event.workspaceId, rules.tagSlug.slice(0, 40), slug);
    const change = await addTag(event.workspaceId, referrer.id, tag.id, "AUTOMATION", `referral:${event.id}`);
    return { tag: { slug: tag.slug, changed: change.changed }, done: true };
  } catch (error) {
    const message = errorText(error, "teg qo'shilmadi");
    return { tag: { skipped: message }, done: false, error: message };
  }
}

/** Idempotent through the ledger's unique key. `done` is false only when awardPoints reported an error. */
async function pointsStep(rules: RewardRules, event: ReferralEvent, referrer: Contact, now: Date): Promise<{ points: RewardSnapshot["points"]; done: boolean; error?: string }> {
  if (!referrer) return { points: { awarded: false, points: 0, skipped: "no_contact" }, done: true };
  try {
    const result = await awardPoints({
      workspaceId: event.workspaceId,
      contactId: referrer.id,
      reason: "referral_qualified",
      points: rules.points,
      sourceTable: "ReferralEvent",
      sourceId: event.id,
      occurredAt: now,
    });
    const failed = result.skipped === "error";
    return {
      points: { awarded: result.awarded, points: result.points, ...(result.skipped ? { skipped: result.skipped } : {}) },
      done: !failed,
      ...(failed ? { error: "ball yozilmadi" } : {}),
    };
  } catch (error) {
    const message = errorText(error, "ball yozilmadi");
    return { points: { awarded: false, points: 0, skipped: "error" }, done: false, error: message };
  }
}

async function applyReward(event: ReferralEvent, program: ReferralProgram, now: Date): Promise<RewardSnapshot> {
  const rules = parseRewardRules(program.rewardRules);
  const workspaceId = event.workspaceId;
  const snapshot: RewardSnapshot = {
    at: now.toISOString(),
    tagDone: false,
    pointsDone: false,
    referrerContactId: null,
    tag: null,
    points: null,
    telegram: null,
    dm: null,
    refereeDm: null,
  };
  const errors: Record<string, string> = {};

  let referrer: Contact = null;
  let referee: Contact = null;
  try {
    ({ referrer, referee } = await loadParties(event, program));
  } catch (error) {
    errors.contacts = errorText(error, "kontaktlar o'qilmadi");
  }
  snapshot.referrerContactId = referrer?.id ?? null;
  const partiesKnown = !errors.contacts;

  if (partiesKnown) {
    const tag = await tagStep(rules, event, referrer);
    snapshot.tag = tag.tag;
    snapshot.tagDone = tag.done;
    if (tag.error) errors.tag = tag.error;

    const points = await pointsStep(rules, event, referrer, now);
    snapshot.points = points.points;
    snapshot.pointsDone = points.done;
    if (points.error) errors.points = points.error;
  }

  // Telegram to the owner
  if (rules.telegramOwner) {
    try {
      const who = displayName(referrer, `ID ${event.referrerIgUserId}`);
      const friend = displayName(referee, `ID ${event.refereeIgUserId}`);
      const text = referralTelegramText(program.qualifier, who, friend, snapshot.points?.awarded ? snapshot.points.points : null);
      snapshot.telegram = { delivered: await notifyWorkspaceChats(workspaceId, text) };
    } catch (error) {
      snapshot.telegram = { skipped: errorText(error, "Telegram yuborilmadi") };
      errors.telegram = snapshot.telegram.skipped;
    }
  }

  // DMs: only inside the 24h window, through the quota / rate guard.
  if (rules.dmTemplate || rules.refereeDmTemplate) {
    try {
      const account = await prisma.instagramAccount.findUnique({ where: { id: program.instagramAccountId } });
      if (account) {
        if (rules.dmTemplate) {
          snapshot.dm = await sendOne(workspaceId, account, event.referrerIgUserId, referrer, render(rules.dmTemplate, displayName(referrer, "do'st")), now);
        }
        if (rules.refereeDmTemplate) {
          snapshot.refereeDm = await sendOne(
            workspaceId,
            account,
            event.refereeIgUserId,
            referee,
            render(rules.refereeDmTemplate, displayName(referee, "do'st")),
            now
          );
        }
      } else {
        if (rules.dmTemplate) snapshot.dm = { sent: false, reason: "akkaunt topilmadi" };
        if (rules.refereeDmTemplate) snapshot.refereeDm = { sent: false, reason: "akkaunt topilmadi" };
      }
    } catch (error) {
      const message = errorText(error, "DM yuborilmadi");
      errors.dm = message;
      if (rules.dmTemplate && !snapshot.dm) snapshot.dm = { sent: false, reason: message };
      if (rules.refereeDmTemplate && !snapshot.refereeDm) snapshot.refereeDm = { sent: false, reason: message };
    }
  }
  if (Object.keys(errors).length > 0) snapshot.errors = errors;
  return snapshot;
}

function snapshotComplete(value: unknown): boolean {
  const snapshot = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<RewardSnapshot>) : null;
  return Boolean(snapshot && snapshot.tagDone === true && snapshot.pointsDone === true);
}

/** A REWARDED event whose idempotent steps did not both finish. */
export function needsRewardRedrive(event: Pick<ReferralEvent, "status" | "rewardSnapshot">): boolean {
  return event.status === "REWARDED" && !snapshotComplete(event.rewardSnapshot);
}

/**
 * Re-run ONLY the idempotent steps (tag, points) of a REWARDED event and merge
 * the result into its snapshot. The Telegram message and the DMs are never
 * repeated. Returns false when there was nothing to do.
 */
export async function redriveRewardSideEffects(eventId: string, now: Date = new Date()): Promise<boolean> {
  const event = await prisma.referralEvent.findUnique({ where: { id: eventId } });
  if (!event || !needsRewardRedrive(event)) return false;
  const program = await prisma.referralProgram.findUnique({ where: { id: event.programId } });
  if (!program) return false;

  const rules = parseRewardRules(program.rewardRules);
  const base = (event.rewardSnapshot && typeof event.rewardSnapshot === "object" && !Array.isArray(event.rewardSnapshot)
    ? (event.rewardSnapshot as unknown as Partial<RewardSnapshot>)
    : {}) as Partial<RewardSnapshot>;
  const errors: Record<string, string> = {};
  let referrer: Contact = null;
  try {
    ({ referrer } = await loadParties(event, program));
  } catch (error) {
    errors.contacts = errorText(error, "kontaktlar o'qilmadi");
  }
  const snapshot: RewardSnapshot = {
    at: base.at ?? (event.rewardedAt ?? now).toISOString(),
    tag: base.tag ?? null,
    points: base.points ?? null,
    telegram: base.telegram ?? null,
    dm: base.dm ?? null,
    refereeDm: base.refereeDm ?? null,
    referrerContactId: referrer?.id ?? base.referrerContactId ?? null,
    tagDone: base.tagDone === true,
    pointsDone: base.pointsDone === true,
    redrivenAt: now.toISOString(),
  };
  if (!errors.contacts) {
    if (!snapshot.tagDone) {
      const tag = await tagStep(rules, event, referrer);
      snapshot.tag = tag.tag;
      snapshot.tagDone = tag.done;
      if (tag.error) errors.tag = tag.error;
    }
    if (!snapshot.pointsDone) {
      const points = await pointsStep(rules, event, referrer, event.rewardedAt ?? now);
      snapshot.points = points.points;
      snapshot.pointsDone = points.done;
      if (points.error) errors.points = points.error;
    }
  }
  if (Object.keys(errors).length > 0) snapshot.errors = errors;
  await prisma.referralEvent.update({ where: { id: event.id }, data: { rewardSnapshot: JSON.parse(JSON.stringify(snapshot)) } });
  return true;
}
