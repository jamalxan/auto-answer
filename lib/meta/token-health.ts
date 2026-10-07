/**
 * Real Instagram token health.
 *
 * "Connected" used to mean "an InstagramAccount row exists", so a token Meta
 * had already revoked (error 190) still showed as connected while every DM
 * silently failed. We now verify against Meta and persist the result.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { TokenExpiredError, getUserInfo } from "@/lib/meta/client";
import { alertWorkspace } from "@/lib/telegram/notify";

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type TokenCheckResult = "active" | "broken" | "error";

export async function markTokenBroken(accountId: string, reason: string) {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, workspaceId: true, username: true, tokenStatus: true, tokenAlertedAt: true },
  });
  if (!account) return;

  const now = new Date();
  const firstTime = account.tokenStatus !== "BROKEN";
  const shouldAlert =
    firstTime ||
    !account.tokenAlertedAt ||
    now.getTime() - account.tokenAlertedAt.getTime() > ALERT_COOLDOWN_MS;

  await prisma.instagramAccount.update({
    where: { id: account.id },
    data: {
      tokenStatus: "BROKEN",
      tokenCheckedAt: now,
      tokenLastError: reason.slice(0, 500),
      ...(firstTime ? { tokenBrokenAt: now } : {}),
      ...(shouldAlert ? { tokenAlertedAt: now } : {}),
    },
  });

  if (firstTime) {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: account.workspaceId,
        source: "TOKEN_REFRESH",
        level: "ERROR",
        message: `Instagram token for @${account.username} is no longer valid: ${reason}`.slice(0, 500),
        payload: { instagramAccountId: account.id },
      },
    });
  }

  if (shouldAlert) {
    await alertWorkspace(
      account.workspaceId,
      `Instagram @${account.username} ulanishi uzildi`,
      `⚠️ <b>Instagram @${account.username} ulanishi uzildi</b>\nKampaniyalar va assistent ishlamayapti. SocialAuto → Sozlamalar bo'limida akkauntni qayta ulang.`,
      `Instagram @${account.username} ulanishi uzildi. Kampaniyalar va assistent ishlamayapti. SocialAuto → Sozlamalar bo'limida akkauntni qayta ulang.`
    );
  }
}

export async function markTokenHealthy(accountId: string) {
  await prisma.instagramAccount.update({
    where: { id: accountId },
    data: {
      tokenStatus: "ACTIVE",
      tokenCheckedAt: new Date(),
      tokenLastError: null,
      tokenBrokenAt: null,
      tokenAlertedAt: null,
    },
  });
}

/** One real Graph API call with the stored token. */
export async function checkAccountToken(accountId: string): Promise<TokenCheckResult> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, accessToken: true },
  });
  if (!account) return "error";

  if (!account.accessToken) {
    // Disconnected by the user (see /api/instagram/disconnect): nothing to
    // verify, and no point alerting them about something they just did.
    await prisma.instagramAccount.update({
      where: { id: account.id },
      data: { tokenCheckedAt: new Date() },
    });
    return "broken";
  }

  let token: string;
  try {
    token = decryptToken(account.accessToken);
  } catch {
    await markTokenBroken(account.id, "Stored token cannot be decrypted (ENCRYPTION_KEY changed?)");
    return "broken";
  }

  try {
    await getUserInfo(token);
    await markTokenHealthy(account.id);
    return "active";
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      await markTokenBroken(account.id, error.message);
      return "broken";
    }
    // Rate limits / network blips say nothing about the token itself.
    await prisma.instagramAccount.update({
      where: { id: account.id },
      data: { tokenCheckedAt: new Date() },
    });
    return "error";
  }
}

export async function checkAllAccountTokens() {
  const accounts = await prisma.instagramAccount.findMany({ select: { id: true } });
  const summary = { active: 0, broken: 0, error: 0 };
  for (const { id } of accounts) {
    summary[await checkAccountToken(id)]++;
  }
  return { total: accounts.length, ...summary };
}
