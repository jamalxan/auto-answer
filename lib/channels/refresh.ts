/**
 * Credential refresh worker (audit 2026-10-26, T1), run from the daily
 * /api/cron/refresh-tokens:
 *
 *   instagram, threads   refresh 10 days before expiry (60-day tokens)
 *   facebook, telegram   daily liveness check (debug_token / getMe)
 *   youtube              access tokens are refreshed on demand by the adapter;
 *                        the daily pass only checks the refresh token still works
 *
 * A failure on an auth / permission error marks the row ERROR, tells the
 * owner once (Telegram + operational event) and makes isCredentialUsable()
 * false, so the publish / reply queues stop for that account. A transient
 * error keeps the status and is retried next run.
 */

import { prisma } from "@/lib/db/client";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { adapterFor } from "./registry";
import { ChannelError, type ChannelId } from "./types";
import { decryptPayload, kekRingFromEnv, updateSecret, type CredentialSecret, type KekRing } from "./vault";

const DAY_MS = 86_400_000;
export const REFRESH_BEFORE_DAYS = 10;
const EXPIRING_DAYS = 3;
const REFRESH_CHANNELS = new Set<ChannelId>(["instagram", "threads"]);
const CHECK_CHANNELS = new Set<ChannelId>(["facebook", "telegram", "youtube"]);

const CHANNEL_NAME: Record<ChannelId, string> = { instagram: "Instagram", facebook: "Facebook", threads: "Threads", youtube: "YouTube", telegram: "Telegram" };

export interface RefreshSummary {
  refreshed: number;
  checked: number;
  failed: number;
  skipped: number;
}

async function fail(row: { id: string; workspaceId: string; channel: string; label: string | null; externalAccountId: string; alertedAt: Date | null; expiresAt: Date | null }, error: unknown, now: Date) {
  const kind = error instanceof ChannelError ? error.kind : "transient";
  const permanent = kind === "auth" || kind === "permission";
  const expiringSoon = row.expiresAt !== null && row.expiresAt.getTime() - now.getTime() < EXPIRING_DAYS * DAY_MS;
  await prisma.channelCredential.update({
    where: { id: row.id },
    data: { lastErrorCode: kind, lastErrorAt: now, checkedAt: now, ...(permanent ? { status: "ERROR" as const } : expiringSoon ? { status: "EXPIRING" as const } : {}) },
  });
  if ((permanent || expiringSoon) && !row.alertedAt) {
    const name = CHANNEL_NAME[row.channel as ChannelId] ?? row.channel;
    const who = row.label ?? row.externalAccountId;
    const text = permanent
      ? `⚠️ <b>${esc(name)} ulanishi ishlamayapti</b>\n${esc(who)}\nNashr va javoblar shu akkaunt uchun to'xtatildi. Panelda qayta ulang.`
      : `⏳ <b>${esc(name)} tokeni muddati tugayapti</b>\n${esc(who)}\nYangilab bo'lmadi — panelda qayta ulang.`;
    await notifyWorkspaceChats(row.workspaceId, text).catch(() => 0);
    await prisma.operationalEvent
      .create({ data: { source: "TOKEN_REFRESH", level: permanent ? "ERROR" : "WARNING", workspaceId: row.workspaceId, message: `${name} credential ${permanent ? "error" : "expiring"}: ${kind}` } })
      .catch(() => {});
    await prisma.channelCredential.update({ where: { id: row.id }, data: { alertedAt: now } });
  }
}

export async function runCredentialRefresh(now = new Date(), ring: KekRing = kekRingFromEnv()): Promise<RefreshSummary> {
  const summary: RefreshSummary = { refreshed: 0, checked: 0, failed: 0, skipped: 0 };
  const rows = (await prisma.channelCredential.findMany({
    where: { status: { in: ["ACTIVE", "EXPIRING"] } },
    orderBy: { checkedAt: { sort: "asc", nulls: "first" } },
    take: 500,
  })) as Array<{
    id: string;
    workspaceId: string;
    channel: string;
    externalAccountId: string;
    label: string | null;
    encryptedPayload: string;
    dekEncrypted: string;
    keyVersion: number;
    expiresAt: Date | null;
    checkedAt: Date | null;
    alertedAt: Date | null;
  }>;
  for (const row of rows) {
    const channel = row.channel as ChannelId;
    const adapter = adapterFor(channel);
    if (!adapter) {
      summary.skipped++;
      continue;
    }
    let secret: CredentialSecret;
    try {
      secret = decryptPayload<CredentialSecret>(row, ring);
    } catch (error) {
      summary.failed++;
      await fail(row, new ChannelError("auth", error instanceof Error ? error.message : "decrypt"), now);
      continue;
    }
    const creds = { accessToken: secret.accessToken, refreshToken: secret.refreshToken ?? null, externalAccountId: row.externalAccountId, expiresAt: row.expiresAt, extra: secret.extra };
    try {
      if (REFRESH_CHANNELS.has(channel)) {
        if (row.expiresAt && row.expiresAt.getTime() - now.getTime() > REFRESH_BEFORE_DAYS * DAY_MS) {
          summary.skipped++;
          continue;
        }
        const next = await adapter.refreshCredentials(creds);
        await updateSecret(row.id, { ...secret, accessToken: next.accessToken, refreshToken: next.refreshToken ?? secret.refreshToken ?? null }, next.expiresAt, ring);
        summary.refreshed++;
      } else if (CHECK_CHANNELS.has(channel)) {
        if (row.checkedAt && now.getTime() - row.checkedAt.getTime() < DAY_MS - 60 * 60_000) {
          summary.skipped++;
          continue;
        }
        const check = await adapter.checkCredentials(creds);
        if (!check.ok) throw new ChannelError(check.error === "auth" ? "auth" : "transient", check.error ?? "check failed");
        await prisma.channelCredential.update({ where: { id: row.id }, data: { checkedAt: now, lastErrorCode: null, lastErrorAt: null, status: "ACTIVE", alertedAt: null } });
        summary.checked++;
      } else {
        summary.skipped++;
      }
    } catch (error) {
      summary.failed++;
      await fail(row, error, now);
    }
  }
  return summary;
}
