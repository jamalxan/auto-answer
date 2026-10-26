/**
 * Telegram link codes (audit 2026-10-26, T3.1): the raw code only ever
 * exists in the deep link the owner opens; the database keeps its SHA-256,
 * so a leaked table cannot be replayed. Single use (claimed atomically) and
 * short-lived (link: 10 minutes).
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";

export const LINK_CODE_TTL_MS = 10 * 60_000;

export function hashLinkCode(raw: string): string {
  return `h:${createHash("sha256").update(raw).digest("hex")}`;
}

export interface NewLinkCode {
  workspaceId: string;
  purpose: "link" | "onboarding";
  userId?: string | null;
  igAccountId?: string | null;
  ttlMs: number;
  /** "onb_" for onboarding codes (the bot routes on it). */
  prefix?: string;
}

/** Stores the hash, returns the raw code for the deep link. */
export async function createLinkCode(input: NewLinkCode): Promise<string> {
  const raw = `${input.prefix ?? ""}${randomBytes(12).toString("base64url")}`;
  await prisma.telegramLinkCode.create({
    data: {
      code: hashLinkCode(raw),
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      userId: input.userId ?? null,
      igAccountId: input.igAccountId ?? null,
      expiresAt: new Date(Date.now() + input.ttlMs),
    },
  });
  return raw;
}

/** The code's row if it is valid, claimed for this caller; null otherwise. */
export async function consumeLinkCode(raw: string, now = new Date()) {
  // Rows written before hashing used the raw code as the key; they expire within minutes of a deploy.
  for (const key of [hashLinkCode(raw), raw]) {
    const row = await prisma.telegramLinkCode.findUnique({ where: { code: key } });
    if (!row) continue;
    if (row.usedAt || row.expiresAt < now) return null;
    const claimed = await prisma.telegramLinkCode.updateMany({ where: { code: key, usedAt: null }, data: { usedAt: now } });
    return claimed.count === 1 ? row : null;
  }
  return null;
}
