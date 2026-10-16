/**
 * ETAP 9.3 — referral codes. One code per (program, referrer): 6 characters
 * without 0/O/1/I, drawn from crypto randomness with rejection sampling (no
 * modulo bias). The link is `https://ig.me/m/<username>?ref=rf_<code>`; the
 * `rf_` prefix tells the attribution scan (and the CRM tagger) it is a
 * referral, not a campaign link.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/crm/errors";
import { notFound, unprocessable } from "../errors";

export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;
export const REF_PREFIX = "rf_";
const MAX_COLLISION_RETRIES = 8;

/** Largest multiple of the alphabet size that fits a byte; bytes above it are rejected. */
const LIMIT = 256 - (256 % CODE_ALPHABET.length);

export function generateCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= LIMIT) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

export function referralLink(username: string, code: string): string {
  return `https://ig.me/m/${username.replace(/^@/, "")}?ref=${REF_PREFIX}${code}`;
}

/** "rf_ab12cd" → "AB12CD"; null when it is not a referral ref. */
export function codeFromRef(ref: string | null | undefined): string | null {
  const value = ref?.trim();
  if (!value || !value.toLowerCase().startsWith(REF_PREFIX)) return null;
  const code = value.slice(REF_PREFIX.length).trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

export interface CreateCodeInput {
  igUserId?: string;
  contactId?: string;
}

/** Idempotent per (program, igUserId): a second call returns the existing code. */
export async function createReferralCode(workspaceId: string, programId: string, input: CreateCodeInput) {
  const program = await prisma.referralProgram.findFirst({ where: { id: programId, workspaceId } });
  if (!program) throw notFound("Referral dasturi topilmadi");

  let igUserId = input.igUserId?.trim() || null;
  let contactId: string | null = null;
  if (input.contactId) {
    const contact = await prisma.crmContact.findFirst({ where: { id: input.contactId, workspaceId } });
    if (!contact || contact.instagramAccountId !== program.instagramAccountId) throw notFound("Kontakt topilmadi");
    if (igUserId && igUserId !== contact.igUserId) throw unprocessable("Kontakt va Instagram ID mos kelmadi");
    igUserId = contact.igUserId;
    contactId = contact.id;
  }
  if (!igUserId) throw unprocessable("Taklif qiluvchi ko'rsatilmagan");

  if (!contactId) {
    const known = await prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: program.instagramAccountId, igUserId } },
      select: { id: true },
    });
    contactId = known?.id ?? null;
  }

  const existing = await prisma.referralCode.findUnique({ where: { programId_igUserId: { programId, igUserId } } });
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    try {
      return await prisma.referralCode.create({
        data: { programId, workspaceId, instagramAccountId: program.instagramAccountId, contactId, igUserId, code: generateCode() },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either the same referrer raced us (return theirs) or the random code collided (retry).
      const raced = await prisma.referralCode.findUnique({ where: { programId_igUserId: { programId, igUserId } } });
      if (raced) return raced;
    }
  }
  throw unprocessable("Kod yaratib bo'lmadi, qayta urinib ko'ring");
}

export interface CodeListItem {
  id: string;
  code: string;
  igUserId: string;
  contactId: string | null;
  username: string | null;
  createdAt: Date;
  lastSharedAt: Date | null;
  events: number;
  qualified: number;
  rewarded: number;
}

export async function listCodes(
  workspaceId: string,
  programId: string,
  options: { cursor?: string | null; limit?: number } = {}
): Promise<{ items: CodeListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const rows = await prisma.referralCode.findMany({
    where: { workspaceId, programId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const codeIds = page.map((row) => row.id);
  const events = codeIds.length
    ? await prisma.referralEvent.findMany({ where: { programId, codeId: { in: codeIds } }, select: { codeId: true, status: true } })
    : [];
  const contactIds = page.map((row) => row.contactId).filter((id): id is string => Boolean(id));
  const contacts = contactIds.length
    ? await prisma.crmContact.findMany({ where: { workspaceId, id: { in: contactIds } }, select: { id: true, username: true } })
    : [];
  const usernames = new Map(contacts.map((contact) => [contact.id, contact.username]));
  return {
    items: page.map((row) => {
      const mine = events.filter((event) => event.codeId === row.id);
      return {
        id: row.id,
        code: row.code,
        igUserId: row.igUserId,
        contactId: row.contactId ?? null,
        username: row.contactId ? (usernames.get(row.contactId) ?? null) : null,
        createdAt: row.createdAt,
        lastSharedAt: row.lastSharedAt ?? null,
        events: mine.length,
        qualified: mine.filter((event) => event.status === "QUALIFIED" || event.status === "REWARDED").length,
        rewarded: mine.filter((event) => event.status === "REWARDED").length,
      };
    }),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}
