/**
 * Loads the workspace's Instagram accounts with their derived status
 * (connection-status.ts) and runs a manual re-check. Never returns the token.
 */

import { prisma } from "@/lib/db/client";
import { checkAccountToken, type TokenCheckResult } from "@/lib/meta/token-health";
import { deriveConnectionStatus, type DerivedConnection } from "./connection-status";

export interface ConnectionView extends DerivedConnection {
  id: string;
  instagramId: string;
  username: string;
  webhookSubscribed: boolean;
  tokenExpiresAt: string | null;
  tokenCheckedAt: string | null;
  tokenBrokenAt: string | null;
  connectedAt: string;
}

const SELECT = {
  id: true,
  instagramId: true,
  username: true,
  accessToken: true,
  tokenExpiresAt: true,
  tokenStatus: true,
  tokenCheckedAt: true,
  tokenLastError: true,
  tokenBrokenAt: true,
  webhookSubscribed: true,
  connectedAt: true,
} as const;

type Row = {
  id: string;
  instagramId: string;
  username: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  tokenStatus: string;
  tokenCheckedAt: Date | null;
  tokenLastError: string | null;
  tokenBrokenAt: Date | null;
  webhookSubscribed: boolean;
  connectedAt: Date;
};

function toView(row: Row, now: Date): ConnectionView {
  return {
    ...deriveConnectionStatus(row, now),
    id: row.id,
    instagramId: row.instagramId,
    username: row.username,
    webhookSubscribed: row.webhookSubscribed,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    tokenCheckedAt: row.tokenCheckedAt?.toISOString() ?? null,
    tokenBrokenAt: row.tokenBrokenAt?.toISOString() ?? null,
    connectedAt: row.connectedAt.toISOString(),
  };
}

export async function loadConnections(workspaceId: string, now: Date = new Date()): Promise<ConnectionView[]> {
  const rows = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: SELECT,
  });
  return rows.map((row) => toView(row, now));
}

/**
 * Real Graph call for one account of this workspace. null when the account
 * is not in the workspace — the route answers 404 without saying whether it
 * exists elsewhere.
 */
export async function recheckConnection(
  workspaceId: string,
  accountId: string
): Promise<{ result: TokenCheckResult; connection: ConnectionView } | null> {
  const owned = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true },
  });
  if (!owned) return null;

  const result = await checkAccountToken(owned.id);
  const row = await prisma.instagramAccount.findFirst({
    where: { id: owned.id, workspaceId },
    select: SELECT,
  });
  if (!row) return null;
  return { result, connection: toView(row, new Date()) };
}
