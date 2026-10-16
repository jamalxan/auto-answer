/**
 * ETAP 8 — credentials of the bus connectors, stored with the same
 * AES-GCM helpers as every other integration (lib/integrations/crypto).
 *
 *   WEBHOOK / MAKE / ZAPIER  { secret, previousSecret?, previousSecretExpiresAt? }
 *   GOOGLE_SHEETS            { client_email, private_key }
 *
 * Nothing in here is ever returned by an API: `secretHintOf` shows only the
 * last four characters of the signing secret (or the Sheets client_email,
 * which is not a secret and which the owner must share the sheet with).
 */

import type { Integration } from "@/app/generated/prisma/client";
import { decryptCredentials, encryptCredentials, maskSecret } from "@/lib/integrations/crypto";
import { SECRET_OVERLAP_HOURS } from "./config";
import { generateWebhookSecret } from "./signing";

export interface WebhookCredentials extends Record<string, unknown> {
  secret: string;
  previousSecret?: string | null;
  /** ISO time after which `previousSecret` no longer signs. */
  previousSecretExpiresAt?: string | null;
}

export interface SheetsCredentials extends Record<string, unknown> {
  client_email: string;
  private_key: string;
}

export function readWebhookCredentials(integration: Pick<Integration, "credentialsEncrypted">): WebhookCredentials | null {
  try {
    const credentials = decryptCredentials<Partial<WebhookCredentials>>(integration.credentialsEncrypted);
    return typeof credentials.secret === "string" && credentials.secret ? (credentials as WebhookCredentials) : null;
  } catch {
    return null;
  }
}

export function readSheetsCredentials(integration: Pick<Integration, "credentialsEncrypted">): SheetsCredentials | null {
  try {
    const credentials = decryptCredentials<Partial<SheetsCredentials>>(integration.credentialsEncrypted);
    return typeof credentials.client_email === "string" && typeof credentials.private_key === "string"
      ? (credentials as SheetsCredentials)
      : null;
  } catch {
    return null;
  }
}

/** The previous secret while its 24h overlap lasts, otherwise null. */
export function activePreviousSecret(credentials: WebhookCredentials, now: Date = new Date()): string | null {
  if (!credentials.previousSecret || !credentials.previousSecretExpiresAt) return null;
  const expires = new Date(credentials.previousSecretExpiresAt).getTime();
  return Number.isFinite(expires) && expires > now.getTime() ? credentials.previousSecret : null;
}

export interface Rotation {
  /** The new secret — shown once to the caller. */
  secret: string;
  encrypted: string;
  previousSecretExpiresAt: Date;
}

/** New secret; the old one keeps signing for SECRET_OVERLAP_HOURS. */
export function rotateWebhookSecret(current: WebhookCredentials, now: Date = new Date()): Rotation {
  const secret = generateWebhookSecret();
  const previousSecretExpiresAt = new Date(now.getTime() + SECRET_OVERLAP_HOURS * 3_600_000);
  const encrypted = encryptCredentials({
    secret,
    previousSecret: current.secret,
    previousSecretExpiresAt: previousSecretExpiresAt.toISOString(),
  });
  return { secret, encrypted, previousSecretExpiresAt };
}

export function encryptWebhookSecret(secret: string): string {
  return encryptCredentials({ secret });
}

/** `••••abcd` of the signing secret, or the Sheets service-account email; "" when nothing is readable. */
export function secretHintOf(integration: Pick<Integration, "type" | "credentialsEncrypted">): string {
  if (integration.type === "GOOGLE_SHEETS") {
    return readSheetsCredentials(integration)?.client_email ?? "";
  }
  const webhook = readWebhookCredentials(integration);
  return webhook ? maskSecret(webhook.secret) : "";
}
