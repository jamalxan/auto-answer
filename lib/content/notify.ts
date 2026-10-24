/**
 * ETAP 13 Faza 2 (WP-E) — the two spec §11 notifications Faza 1 lacked,
 * run by the minute sweeper:
 *
 *   - "Kvota 80%": an account that has used (or queued) 80% of Meta's 24 h
 *     publishing limit → Telegram, once per account per 24 h window. The
 *     dashboard side is the calendar's quota pill (already amber at 80%) and
 *     the OperationalEvent WARNING written here.
 *   - "Ertaga X ta post, akkaunt BROKEN": an account that cannot publish
 *     (tokenStatus BROKEN or canPublish=false) with auto-publish posts due in
 *     the next 24 h → Telegram + email, once per account per local day.
 *
 * Dedupe needs no migration: the OperationalEvent row written with each
 * notice is the marker (stable message per account / window), and a key
 * lock keeps two overlapping sweepers from both sending.
 */

import { prisma } from "@/lib/db/client";
import { esc } from "@/lib/telegram/api";
import { alertWorkspace, notifyWorkspaceChats } from "@/lib/telegram/notify";
import { withKeyLock } from "./lock";
import { accountQuota, type AccountQuota } from "./quota";
import { formatZoned, utcToZoned } from "./time";
import { QUEUED } from "./transitions";

export const QUOTA_WARN_RATIO = 0.8;
const DAY_MS = 24 * 3_600_000;
const BATCH = 100;

export interface NotifyResult {
  quotaWarnings: number;
  brokenWarnings: number;
}

export const quotaMarker = (accountId: string) => `Content quota 80% reached: account ${accountId}`;
export const brokenMarker = (accountId: string, day: string) => `Content account cannot publish, posts due: account ${accountId} (${day})`;

async function markerSince(workspaceId: string, message: string, since: Date): Promise<boolean> {
  const row = await prisma.operationalEvent.findFirst({ where: { workspaceId, source: "WORKER", message, createdAt: { gte: since } }, select: { id: true } });
  return Boolean(row);
}

async function writeMarker(workspaceId: string, message: string, payload: Record<string, unknown>, now: Date): Promise<void> {
  await prisma.operationalEvent.create({ data: { workspaceId, source: "WORKER", level: "WARNING", message, payload: payload as never, createdAt: now } });
}

export function quotaLoad(q: Pick<AccountQuota, "used" | "scheduledNext24h" | "total">): number {
  return q.total > 0 ? (q.used + q.scheduledNext24h) / q.total : 0;
}

/** "Kvota 80%" for one account; true when a notice went out. */
export async function notifyQuotaIfHigh(accountId: string, now: Date = new Date(), quota?: AccountQuota): Promise<boolean> {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true, workspaceId: true, username: true } });
  if (!account) return false;
  const q = quota ?? (await accountQuota(accountId, now));
  if (quotaLoad(q) < QUOTA_WARN_RATIO) return false;
  const message = quotaMarker(accountId);
  const locked = await withKeyLock(`content:notify:quota:${accountId}`, async () => {
    if (await markerSince(account.workspaceId, message, new Date(now.getTime() - DAY_MS))) return false;
    const load = q.used + q.scheduledNext24h;
    await writeMarker(account.workspaceId, message, { kind: "CONTENT_QUOTA_80", accountId, used: q.used, scheduledNext24h: q.scheduledNext24h, total: q.total }, now);
    await notifyWorkspaceChats(
      account.workspaceId,
      `⚠️ <b>24 soatlik post limiti 80% dan oshdi</b> (@${esc(account.username)}): ${load}/${q.total} — ${q.used} ta chiqdi, ${q.scheduledNext24h} ta navbatda.\nLimit to'lsa keyingi postlar kechikadi. SocialAuto → Kontent.`
    ).catch(() => 0);
    return true;
  });
  return locked.acquired && locked.result;
}

/** Accounts that publish now or will soon: their quota is worth a look. */
async function busyAccounts(now: Date): Promise<string[]> {
  const rows = await prisma.scheduledPost.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: "PUBLISHED", publishedAt: { gte: new Date(now.getTime() - DAY_MS) } },
        { status: { in: QUEUED }, scheduledAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) } },
      ],
    },
    select: { instagramAccountId: true },
    take: 5_000,
  });
  return [...new Set(rows.map((r) => r.instagramAccountId))].slice(0, BATCH);
}

/** "Ertaga X ta post, akkaunt BROKEN" for every account that cannot publish what it has queued. */
export async function notifyBrokenAccounts(now: Date = new Date()): Promise<number> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { OR: [{ tokenStatus: "BROKEN" }, { canPublish: false }] },
    select: { id: true, workspaceId: true, username: true, tokenStatus: true, workspace: { select: { timezone: true } } },
    take: BATCH,
  });
  let sent = 0;
  for (const account of accounts) {
    const due = await prisma.scheduledPost.findMany({
      where: {
        instagramAccountId: account.id,
        deletedAt: null,
        status: { in: QUEUED },
        autoPublish: true,
        manualReason: null,
        scheduledAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) },
      },
      orderBy: { scheduledAt: "asc" },
      select: { id: true, scheduledAt: true },
    });
    if (due.length === 0) continue;
    const tz = account.workspace?.timezone ?? "Asia/Tashkent";
    const day = utcToZoned(now, tz).date;
    const message = brokenMarker(account.id, day);
    const locked = await withKeyLock(`content:notify:broken:${account.id}`, async () => {
      if (await markerSince(account.workspaceId, message, new Date(now.getTime() - 2 * DAY_MS))) return false;
      await writeMarker(account.workspaceId, message, { kind: "CONTENT_ACCOUNT_BROKEN", accountId: account.id, posts: due.length, postIds: due.map((p) => p.id).slice(0, 20) }, now);
      const first = due[0].scheduledAt ? formatZoned(due[0].scheduledAt, tz) : "";
      const why = account.tokenStatus === "BROKEN" ? "Instagram ulanishi uzilgan" : "post chiqarish ruxsati yo'q";
      await alertWorkspace(
        account.workspaceId,
        `Keyingi 24 soatda ${due.length} ta post bor, lekin @${account.username} chiqara olmaydi`,
        `🚨 <b>Keyingi 24 soatda ${due.length} ta post bor</b>, lekin @${esc(account.username)} ularni chiqara olmaydi: ${why}.${first ? `\nBirinchisi: ${first}.` : ""}\nSocialAuto → Akkauntlar bo'limida akkauntni qayta ulang, aks holda postlar chiqmaydi.`,
        `Keyingi 24 soatda ${due.length} ta post bor, lekin @${account.username} ularni chiqara olmaydi: ${why}.${first ? ` Birinchisi: ${first}.` : ""} SocialAuto → Akkauntlar bo'limida akkauntni qayta ulang, aks holda postlar chiqmaydi.`
      ).catch(() => undefined);
      return true;
    });
    if (locked.acquired && locked.result) sent++;
  }
  return sent;
}

/** Sweeper step: both checks, each best effort. */
export async function sweepNotifications(now: Date = new Date()): Promise<NotifyResult> {
  const result: NotifyResult = { quotaWarnings: 0, brokenWarnings: 0 };
  try {
    for (const accountId of await busyAccounts(now)) {
      if (await notifyQuotaIfHigh(accountId, now).catch(() => false)) result.quotaWarnings++;
    }
  } catch (error) {
    console.error("[Content] quota notice failed:", error instanceof Error ? error.message : error);
  }
  try {
    result.brokenWarnings = await notifyBrokenAccounts(now);
  } catch (error) {
    console.error("[Content] broken-account notice failed:", error instanceof Error ? error.message : error);
  }
  return result;
}
