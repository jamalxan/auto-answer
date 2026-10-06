import type { Integration } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { resumeIntegration } from "@/lib/leads/delivery";
import {
  AmoClient,
  LongLivedTokenStrategy,
  type AmoConfig,
  type AmoZone,
} from "./amocrm";
import {
  BitrixClient,
  isValidBitrixWebhookUrl,
  normalizeWebhookUrl,
  type BitrixConfig,
} from "./bitrix24";
import { decryptCredentials, encryptCredentials, maskSecret } from "./crypto";
import { IntegrationAuthError } from "./errors";

export const AMO_ZONES: AmoZone[] = ["amocrm.ru", "kommo.com", "amocrm.com"];

export function amoClientFromIntegration(integration: Integration): AmoClient {
  const credentials = decryptCredentials<{ token: string }>(integration.credentialsEncrypted);
  return new AmoClient(
    integration.config as unknown as AmoConfig,
    new LongLivedTokenStrategy(credentials.token),
    integration.id
  );
}

export function bitrixClientFromIntegration(integration: Integration): BitrixClient {
  const credentials = decryptCredentials<{ webhookUrl: string }>(integration.credentialsEncrypted);
  return new BitrixClient(
    credentials.webhookUrl,
    integration.config as unknown as BitrixConfig,
    integration.id
  );
}

export interface ConnectionCheck {
  ok: boolean;
  /** "auth" = credentials rejected (401/403) -> integration is broken. */
  reason?: "auth" | "error";
  message?: string;
}

/** Real API call against the provider. */
export async function checkIntegration(integration: Integration): Promise<ConnectionCheck> {
  try {
    if (integration.type === "AMOCRM") {
      await amoClientFromIntegration(integration).checkConnection();
    } else if (integration.type === "BITRIX24") {
      await bitrixClientFromIntegration(integration).checkConnection();
    } else {
      const chats = await prisma.telegramChat.count({
        where: { integrationId: integration.id, active: true },
      });
      if (chats === 0) return { ok: false, reason: "error", message: "no_active_chats" };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof IntegrationAuthError) {
      return { ok: false, reason: "auth", message: error.message };
    }
    return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run a connection check and persist the outcome. A repaired integration
 * releases every delivery that was held while it was broken (TZ acceptance #10).
 */
export async function runConnectionCheck(integrationId: string) {
  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const result = await checkIntegration(integration);
  const wasBroken = integration.status === "BROKEN";

  if (result.ok) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: integration.status === "DISABLED" ? "DISABLED" : "ACTIVE",
        lastCheckedAt: new Date(),
        lastError: null,
      },
    });
    if (wasBroken) await resumeIntegration(integration.id);
  } else {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: result.reason === "auth" ? "BROKEN" : integration.status,
        lastCheckedAt: new Date(),
        lastError: (result.message ?? "").slice(0, 500),
      },
    });
  }
  return result;
}

export function serializeIntegration(
  integration: Integration & { telegramChats?: Array<{ id: string; chatId: string; title: string | null; type: string; active: boolean }> },
  counts?: { pending: number; dead: number }
) {
  let secretHint = "";
  try {
    const credentials = decryptCredentials<{ token?: string; webhookUrl?: string }>(integration.credentialsEncrypted);
    secretHint = maskSecret(credentials.token ?? credentials.webhookUrl ?? "");
  } catch {
    secretHint = "";
  }
  return {
    id: integration.id,
    type: integration.type,
    name: integration.name,
    status: integration.status,
    config: integration.config,
    igAccountFilter: integration.igAccountFilter,
    tokenExpiresAt: integration.tokenExpiresAt,
    lastCheckedAt: integration.lastCheckedAt,
    lastError: integration.lastError,
    secretHint,
    chats: integration.telegramChats ?? [],
    pendingDeliveries: counts?.pending ?? 0,
    deadDeliveries: counts?.dead ?? 0,
    createdAt: integration.createdAt,
  };
}

export { encryptCredentials, isValidBitrixWebhookUrl, normalizeWebhookUrl };

// ─── Token expiry warnings (amoCRM long-lived token) ────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Warn when a long-lived token is 14 and 3 days from expiry (TZ 7.2). The
 * `tokenWarnedAt` marker makes each threshold fire once.
 */
export function expiryWarningDue(
  expiresAt: Date,
  warnedAt: Date | null,
  now = new Date()
): 14 | 3 | null {
  const daysLeft = (expiresAt.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft <= 0) return null; // already expired: the API will mark it broken
  const warnedDaysLeft = warnedAt ? (expiresAt.getTime() - warnedAt.getTime()) / DAY_MS : Infinity;
  if (daysLeft <= 3 && warnedDaysLeft > 3) return 3;
  if (daysLeft <= 14 && warnedDaysLeft > 14) return 14;
  return null;
}
