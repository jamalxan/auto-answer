/**
 * Credentials ready for a call: loaded from the vault (tenant-scoped), only
 * when usable, tagged with the tenant for the per-tenant API cap, and with a
 * short-lived access token (YouTube: 1 hour) refreshed first when it is
 * about to expire. A refresh refused with auth marks the row ERROR, so the
 * queues stop for it like after the daily check.
 */

import { prisma } from "@/lib/db/client";
import { adapterFor } from "./registry";
import { ChannelError, type ChannelCredentials, type ChannelId } from "./types";
import { loadCredentials, updateSecret } from "./vault";

const REFRESH_AHEAD_MS = 5 * 60_000;
/** Channels whose access token is short-lived and refreshed on demand. */
const ON_DEMAND = new Set<ChannelId>(["youtube"]);

export type UsableCredentials = ChannelCredentials & { channel: ChannelId; credentialId: string; label: string | null };

export async function usableCredentials(workspaceId: string, credentialId: string, now = new Date()): Promise<UsableCredentials> {
  let creds;
  try {
    creds = await loadCredentials(workspaceId, credentialId);
  } catch (error) {
    throw new ChannelError("auth", error instanceof Error ? error.message : "Credential topilmadi");
  }
  if (creds.status !== "ACTIVE" && creds.status !== "EXPIRING") throw new ChannelError("auth", "Ulanish ishlamayapti — panelda qayta ulang");
  const row = await prisma.channelCredential.findFirst({ where: { id: credentialId, workspaceId }, select: { label: true } });
  const ready: UsableCredentials = { ...creds, credentialId, label: row?.label ?? null, extra: { ...(creds.extra ?? {}), tenantId: workspaceId } };

  if (ON_DEMAND.has(creds.channel) && (!creds.expiresAt || creds.expiresAt.getTime() - now.getTime() < REFRESH_AHEAD_MS)) {
    const adapter = adapterFor(creds.channel);
    if (!adapter) throw new ChannelError("not_supported", `${creds.channel} adapteri yo'q`);
    try {
      const next = await adapter.refreshCredentials(ready);
      await updateSecret(credentialId, { accessToken: next.accessToken, refreshToken: next.refreshToken ?? creds.refreshToken ?? null, extra: creds.extra }, next.expiresAt);
      ready.accessToken = next.accessToken;
      ready.refreshToken = next.refreshToken ?? creds.refreshToken ?? null;
      ready.expiresAt = next.expiresAt;
    } catch (error) {
      if (error instanceof ChannelError && error.kind === "auth") {
        await prisma.channelCredential.update({ where: { id: credentialId }, data: { status: "ERROR", lastErrorCode: "auth", lastErrorAt: now } });
      }
      throw error;
    }
  }
  return ready;
}
