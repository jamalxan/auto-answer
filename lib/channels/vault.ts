/**
 * Credential vault (audit 2026-10-26, T1). Every channel token lives in
 * ChannelCredential, envelope-encrypted:
 *
 *   payload ──AES-256-GCM──▶ encryptedPayload      (random 256-bit DEK per row)
 *   DEK     ──AES-256-GCM──▶ dekEncrypted          (KEK of keyVersion)
 *
 * KEKs come from the environment (a secret manager in production):
 *   CREDENTIAL_KEKS="1:<base64 32 bytes>,2:<base64 32 bytes>"
 *   CREDENTIAL_KEK_VERSION=2        (the one new rows are written with)
 * Without them, version 0 is derived from ENCRYPTION_KEY so the vault works
 * on day one; rotating to a real KEK later only re-wraps the DEKs
 * (`rewrapCredentials`), the payloads are never decrypted for that.
 *
 * Nothing here returns a secret to an API: `publicCredential` is the only
 * shape that leaves the server. Instagram's legacy token column
 * (InstagramAccount.accessToken) is not moved here yet.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ChannelCredentialStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { ChannelCredentials, ChannelId } from "./types";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

export interface KekRing {
  active: number;
  keys: Map<number, Buffer>;
}

export function kekRingFromEnv(env: Record<string, string | undefined> = process.env): KekRing {
  const keys = new Map<number, Buffer>();
  for (const part of (env.CREDENTIAL_KEKS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [v, b64] = part.split(":");
    const version = Number(v);
    const key = Buffer.from(b64 ?? "", "base64");
    if (!Number.isInteger(version) || version < 1 || key.length !== 32) throw new VaultError("CREDENTIAL_KEKS noto'g'ri: har biri <versiya>:<32 baytli base64>");
    keys.set(version, key);
  }
  if (env.ENCRYPTION_KEY) keys.set(0, createHash("sha256").update(`socialauto-kek-v0|${env.ENCRYPTION_KEY}`).digest());
  const configured = env.CREDENTIAL_KEK_VERSION ? Number(env.CREDENTIAL_KEK_VERSION) : keys.size ? Math.max(...keys.keys()) : NaN;
  if (!keys.has(configured)) throw new VaultError("Faol KEK topilmadi (CREDENTIAL_KEKS / CREDENTIAL_KEK_VERSION yoki ENCRYPTION_KEY)");
  return { active: configured, keys };
}

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv(ALGO, key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export interface SealedPayload {
  encryptedPayload: string;
  dekEncrypted: string;
  keyVersion: number;
}

export function encryptPayload(payload: object, ring: KekRing = kekRingFromEnv()): SealedPayload {
  const dek = randomBytes(32);
  return {
    encryptedPayload: seal(dek, Buffer.from(JSON.stringify(payload), "utf8")),
    dekEncrypted: seal(ring.keys.get(ring.active)!, dek),
    keyVersion: ring.active,
  };
}

export function decryptPayload<T>(sealed: SealedPayload, ring: KekRing = kekRingFromEnv()): T {
  const kek = ring.keys.get(sealed.keyVersion);
  if (!kek) throw new VaultError(`KEK v${sealed.keyVersion} yo'q`);
  try {
    const dek = open(kek, sealed.dekEncrypted);
    return JSON.parse(open(dek, sealed.encryptedPayload).toString("utf8")) as T;
  } catch {
    throw new VaultError("Credential ochilmadi (kalit yoki ma'lumot buzilgan)");
  }
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface CredentialSecret {
  accessToken: string;
  refreshToken?: string | null;
  extra?: Record<string, unknown>;
}

export interface PutCredentialInput {
  workspaceId: string;
  channel: ChannelId;
  externalAccountId: string;
  label?: string | null;
  secret: CredentialSecret;
  scopes?: string[];
  expiresAt?: Date | null;
}

/** Create or replace the account's credentials (reconnect = new secret, status back to ACTIVE). */
export async function putCredential(input: PutCredentialInput, ring: KekRing = kekRingFromEnv()) {
  const sealed = encryptPayload(input.secret, ring);
  const data = {
    ...sealed,
    label: input.label ?? null,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    refreshedAt: new Date(),
    status: "ACTIVE" as const,
    lastErrorCode: null,
    lastErrorAt: null,
    alertedAt: null,
  };
  const row = await prisma.channelCredential.upsert({
    where: { workspaceId_channel_externalAccountId: { workspaceId: input.workspaceId, channel: input.channel, externalAccountId: input.externalAccountId } },
    create: { workspaceId: input.workspaceId, channel: input.channel, externalAccountId: input.externalAccountId, ...data },
    update: data,
  });
  return publicCredential(row);
}

type Row = {
  id: string;
  workspaceId: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  encryptedPayload: string;
  dekEncrypted: string;
  keyVersion: number;
  scopes: string[];
  expiresAt: Date | null;
  refreshedAt: Date | null;
  checkedAt: Date | null;
  status: ChannelCredentialStatus;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
};

/** The only shape that may leave the server (API, MCP, UI): no secret, no ciphertext. */
export function publicCredential(row: Row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    channel: row.channel,
    externalAccountId: row.externalAccountId,
    label: row.label,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    refreshedAt: row.refreshedAt,
    checkedAt: row.checkedAt,
    status: row.status,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
  };
}
export type PublicCredential = ReturnType<typeof publicCredential>;

/** Tenant-scoped: another workspace's id is "not found", never its secret. */
export async function loadCredentials(workspaceId: string, credentialId: string, ring: KekRing = kekRingFromEnv()): Promise<ChannelCredentials & { channel: ChannelId; status: ChannelCredentialStatus }> {
  const row = (await prisma.channelCredential.findFirst({ where: { id: credentialId, workspaceId } })) as Row | null;
  if (!row) throw new VaultError("Credential topilmadi");
  if (row.status === "REVOKED") throw new VaultError("Credential bekor qilingan");
  const secret = decryptPayload<CredentialSecret>(row, ring);
  return {
    channel: row.channel as ChannelId,
    status: row.status,
    externalAccountId: row.externalAccountId,
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken ?? null,
    expiresAt: row.expiresAt,
    extra: secret.extra,
  };
}

export async function listCredentials(workspaceId: string, channel?: ChannelId): Promise<PublicCredential[]> {
  const rows = (await prisma.channelCredential.findMany({ where: { workspaceId, ...(channel ? { channel } : {}) }, orderBy: { createdAt: "asc" } })) as Row[];
  return rows.map(publicCredential);
}

/** Usable for publish / replies: ACTIVE or EXPIRING. Queues check this before calling a channel. */
export async function isCredentialUsable(workspaceId: string, channel: ChannelId, externalAccountId: string): Promise<boolean> {
  const row = await prisma.channelCredential.findUnique({
    where: { workspaceId_channel_externalAccountId: { workspaceId, channel, externalAccountId } },
    select: { status: true },
  });
  return row?.status === "ACTIVE" || row?.status === "EXPIRING";
}

/** Revoke: the secret is overwritten (crypto-shredded), the row stays for the audit trail. */
export async function revokeCredential(workspaceId: string, credentialId: string, ring: KekRing = kekRingFromEnv()): Promise<boolean> {
  const shredded = encryptPayload({ accessToken: "", revoked: true }, ring);
  const result = await prisma.channelCredential.updateMany({
    where: { id: credentialId, workspaceId },
    data: { ...shredded, status: "REVOKED", lastErrorCode: "revoked", lastErrorAt: new Date() },
  });
  return result.count > 0;
}

/** Store refreshed tokens (same DEK scheme, fresh DEK). */
export async function updateSecret(credentialId: string, secret: CredentialSecret, expiresAt: Date | null, ring: KekRing = kekRingFromEnv()) {
  await prisma.channelCredential.update({
    where: { id: credentialId },
    data: { ...encryptPayload(secret, ring), expiresAt, refreshedAt: new Date(), checkedAt: new Date(), status: "ACTIVE", lastErrorCode: null, lastErrorAt: null, alertedAt: null },
  });
}

/**
 * KEK rotation: every row not on the active version gets its DEK re-wrapped.
 * Payloads stay untouched. Returns how many rows moved.
 */
export async function rewrapCredentials(ring: KekRing = kekRingFromEnv(), batch = 200): Promise<number> {
  let moved = 0;
  for (;;) {
    const rows = (await prisma.channelCredential.findMany({ where: { keyVersion: { not: ring.active } }, take: batch, select: { id: true, dekEncrypted: true, keyVersion: true } })) as Array<{ id: string; dekEncrypted: string; keyVersion: number }>;
    if (rows.length === 0) return moved;
    for (const row of rows) {
      const oldKek = ring.keys.get(row.keyVersion);
      if (!oldKek) throw new VaultError(`KEK v${row.keyVersion} yo'q — rotatsiyani davom ettirib bo'lmaydi`);
      const dek = open(oldKek, row.dekEncrypted);
      const changed = await prisma.channelCredential.updateMany({
        where: { id: row.id, keyVersion: row.keyVersion },
        data: { dekEncrypted: seal(ring.keys.get(ring.active)!, dek), keyVersion: ring.active },
      });
      moved += changed.count;
    }
  }
}
