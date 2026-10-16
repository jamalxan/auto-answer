/**
 * ETAP 8 — webhook signing.
 *
 *   X-SocialAuto-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
 *
 * `timestamp` is unix seconds (X-SocialAuto-Timestamp). During a secret
 * rotation (24h overlap) the header carries two values, `v1=<new>,v1=<old>`,
 * and a receiver that knows either secret verifies. `verifySignature` is the
 * reference implementation the README snippets mirror.
 *
 * Pure: node:crypto only.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SIGNATURE_TOLERANCE_SEC } from "./config";

export const SECRET_PREFIX = "whsec_";
export const SIGNATURE_SCHEME = "v1";

export const HEADER_EVENT = "X-SocialAuto-Event";
export const HEADER_EVENT_ID = "X-SocialAuto-Event-Id";
export const HEADER_DELIVERY_ID = "X-SocialAuto-Delivery-Id";
export const HEADER_TIMESTAMP = "X-SocialAuto-Timestamp";
export const HEADER_SIGNATURE = "X-SocialAuto-Signature";

/** `whsec_` + 32 random bytes, base64url (43 chars). Shown once, stored encrypted. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isWebhookSecret(value: string): boolean {
  return value.startsWith(SECRET_PREFIX) && value.length > SECRET_PREFIX.length + 20;
}

export function signPayload(secret: string, timestamp: number | string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `${SIGNATURE_SCHEME}=${digest}`;
}

/** The `v1=` values of a signature header, in order. */
export function parseSignatureHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_SCHEME}=`))
    .map((part) => part.slice(SIGNATURE_SCHEME.length + 1).toLowerCase())
    .filter((hex) => /^[0-9a-f]{64}$/.test(hex));
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface VerifySignatureInput {
  secret: string;
  /** Accepted as well during the rotation overlap. */
  previousSecret?: string | null;
  /** Value of X-SocialAuto-Timestamp (unix seconds). */
  timestamp: string | number | null | undefined;
  rawBody: string;
  /** Value of X-SocialAuto-Signature. */
  header: string | null | undefined;
  toleranceSec?: number;
  /** Unix milliseconds. */
  now?: number;
}

export type VerifySignatureResult =
  | { ok: true; usedPrevious: boolean }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function verifySignature(input: VerifySignatureInput): VerifySignatureResult {
  const candidates = parseSignatureHeader(input.header);
  if (!input.header || input.timestamp === null || input.timestamp === undefined || input.timestamp === "") {
    return { ok: false, reason: "missing" };
  }
  const ts = Number(input.timestamp);
  if (!Number.isInteger(ts) || ts <= 0) return { ok: false, reason: "malformed" };
  if (candidates.length === 0) return { ok: false, reason: "malformed" };

  const tolerance = input.toleranceSec ?? SIGNATURE_TOLERANCE_SEC;
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: "expired" };

  const expected = signPayload(input.secret, ts, input.rawBody).slice(SIGNATURE_SCHEME.length + 1);
  if (candidates.some((c) => equalHex(c, expected))) return { ok: true, usedPrevious: false };

  if (input.previousSecret) {
    const previous = signPayload(input.previousSecret, ts, input.rawBody).slice(SIGNATURE_SCHEME.length + 1);
    if (candidates.some((c) => equalHex(c, previous))) return { ok: true, usedPrevious: true };
  }
  return { ok: false, reason: "mismatch" };
}

export interface SignatureHeadersInput {
  event: string;
  eventId: string;
  deliveryId: string;
  /** Unix seconds. */
  timestamp: number;
  rawBody: string;
  secret: string;
  previousSecret?: string | null;
}

/** The X-SocialAuto-* headers of one delivery (signature first with the current secret). */
export function signatureHeaders(input: SignatureHeadersInput): Record<string, string> {
  const signatures = [signPayload(input.secret, input.timestamp, input.rawBody)];
  if (input.previousSecret) signatures.push(signPayload(input.previousSecret, input.timestamp, input.rawBody));
  return {
    [HEADER_EVENT]: input.event,
    [HEADER_EVENT_ID]: input.eventId,
    [HEADER_DELIVERY_ID]: input.deliveryId,
    [HEADER_TIMESTAMP]: String(input.timestamp),
    [HEADER_SIGNATURE]: signatures.join(","),
  };
}
