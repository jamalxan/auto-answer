import type { Integration } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { markIntegrationBroken, resumeIntegration } from "@/lib/leads/delivery";
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
import { checkBusIntegration, isBusOnlyType } from "@/lib/integrations2/connectors";
import { resumeOutboundIntegration } from "@/lib/integrations2/deliver";

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
  // ETAP 8: bus-only types (WEBHOOK / GOOGLE_SHEETS / MAKE / ZAPIER) have their own connector check.
  if (isBusOnlyType(integration.type)) return checkBusIntegration(integration);
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
/** Consecutive passing background checks a BROKEN integration needs before it resumes (no flapping). */
export const RESUME_AFTER_PASSES = 2;

export async function runConnectionCheck(integrationId: string, options: { manual?: boolean } = {}) {
  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const result = await checkIntegration(integration);
  const wasBroken = integration.status === "BROKEN";
  const checkedAt = new Date();

  if (result.ok && wasBroken && !options.manual) {
    // Background check: one pass is not proof (a flapping API would flip the
    // status and alert every 5 minutes). Stay BROKEN until enough passes in a row.
    const streak = (integration.healthOkStreak ?? 0) + 1;
    if (streak < RESUME_AFTER_PASSES) {
      await prisma.integration.update({
        where: { id: integration.id },
        data: { healthOkStreak: streak, lastCheckedAt: checkedAt },
      });
      return result;
    }
  }

  if (result.ok) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: integration.status === "DISABLED" ? "DISABLED" : "ACTIVE",
        lastCheckedAt: new Date(),
        lastError: null,
        ...((integration.healthOkStreak ?? 0) !== 0 ? { healthOkStreak: 0 } : {}),
      },
    });
    // Repaired (or a held lead was left behind): put every waiting delivery
    // back in the queue and close the "integration lost" system error.
    const held = await prisma.leadDelivery.count({
      where: { integrationId: integration.id, status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: null },
    });
    if (wasBroken || held > 0) {
      await resumeIntegration(integration.id);
      await resumeOutboundIntegration(integration.id).catch(() => 0);
    }
    if (wasBroken) {
      await prisma.operationalEvent
        .updateMany({
          where: {
            workspaceId: integration.workspaceId,
            source: "SYSTEM",
            level: "ERROR",
            resolvedAt: null,
            message: { contains: "integratsiyasi uzildi" },
          },
          data: { resolvedAt: checkedAt },
        })
        .catch(() => undefined);
    }
  } else {
    if (result.reason === "auth" && integration.status === "ACTIVE") {
      // Typed INTEGRATION_AUTH_EXPIRED: BROKEN + system error + owner alert (once).
      await markIntegrationBroken(integration, result.message ?? "401");
    }
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: result.reason === "auth" ? "BROKEN" : integration.status,
        // A failed check restarts the passing streak.
        ...((integration.healthOkStreak ?? 0) !== 0 ? { healthOkStreak: 0 } : {}),
        lastCheckedAt: checkedAt,
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
 * Warn when a long-lived token is 7 and 1 day from expiry (B-04, like the
 * Instagram token warnings). The `tokenWarnedAt` marker makes each threshold
 * fire once.
 */
export function expiryWarningDue(
  expiresAt: Date,
  warnedAt: Date | null,
  now = new Date()
): 7 | 1 | null {
  const daysLeft = (expiresAt.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft <= 0) return null; // already expired: the 5-minute check marks it broken
  const warnedDaysLeft = warnedAt ? (expiresAt.getTime() - warnedAt.getTime()) / DAY_MS : Infinity;
  if (daysLeft <= 1 && warnedDaysLeft > 1) return 1;
  if (daysLeft <= 7 && warnedDaysLeft > 7) return 7;
  return null;
}
