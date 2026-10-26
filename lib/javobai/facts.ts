/**
 * Fact candidates → knowledge base (audit 2026-10-26: "AI faktni o'zi
 * qo'shmaydi, egasi tasdiqlaydi"). A candidate comes from the judge
 * (operator replies) or from a manager's Telegram "add to KB"; only the
 * owner's approval turns it into a verified AiKnowledgeEntry, with the
 * shelf life the owner confirmed.
 */

import type { AiKnowledgeKind } from "@/app/generated/prisma/client";
import { findProfile } from "@/lib/assistant/profile";
import { prisma } from "@/lib/db/client";
import { LadderError } from "./ladder-service";

const KINDS: AiKnowledgeKind[] = ["PRICE", "HOURS", "DELIVERY", "CONTACT", "BRANCH", "DISCOUNT", "TERMS", "POLICY", "OTHER"];

export async function listFactCandidates(workspaceId: string, status: "PENDING" | "APPROVED" | "REJECTED" = "PENDING") {
  return prisma.aiFactCandidate.findMany({ where: { workspaceId, status }, orderBy: { createdAt: "desc" }, take: 200 });
}

export interface ApproveInput {
  title?: string;
  body?: string;
  kind?: string;
  /** ISO date or null (no expiry); undefined keeps the candidate's own. */
  validUntil?: string | null;
}

export async function approveFactCandidate(workspaceId: string, id: string, by: string, edits: ApproveInput = {}, now = new Date()) {
  const candidate = await prisma.aiFactCandidate.findFirst({ where: { id, workspaceId } });
  if (!candidate) throw new LadderError(404, "Fakt topilmadi");
  if (candidate.status !== "PENDING") throw new LadderError(409, "Bu fakt allaqachon ko'rib chiqilgan");
  const title = (edits.title ?? candidate.title).trim().slice(0, 120);
  const body = (edits.body ?? candidate.body).trim().slice(0, 2000);
  if (!title || !body) throw new LadderError(400, "Sarlavha va matn kerak");
  const kind = edits.kind && (KINDS as string[]).includes(edits.kind) ? (edits.kind as AiKnowledgeKind) : candidate.kind;
  let expiresAt = candidate.validUntil;
  if (edits.validUntil !== undefined) {
    expiresAt = edits.validUntil ? new Date(edits.validUntil) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new LadderError(400, "Muddat noto'g'ri");
  }
  if (expiresAt && expiresAt <= now) throw new LadderError(400, "Muddat o'tib ketgan");
  return prisma.$transaction(async (tx) => {
    const entry = await tx.aiKnowledgeEntry.create({
      data: { profileId: candidate.profileId, kind, title, body, verifiedAt: now, expiresAt, source: candidate.source === "manager_reply" ? "manager_reply" : "observed" },
    });
    await tx.aiFactCandidate.update({ where: { id }, data: { status: "APPROVED", title, body, kind, validUntil: expiresAt, knowledgeEntryId: entry.id, decidedBy: by, decidedAt: now } });
    return entry;
  });
}

export async function rejectFactCandidate(workspaceId: string, id: string, by: string): Promise<boolean> {
  const changed = await prisma.aiFactCandidate.updateMany({ where: { id, workspaceId, status: "PENDING" }, data: { status: "REJECTED", decidedBy: by, decidedAt: new Date() } });
  return changed.count > 0;
}

/** Manager's Telegram "add to KB": a pending candidate the owner still approves. */
export async function proposeManagerFact(workspaceId: string, instagramAccountId: string | null, text: string, by: string): Promise<string | null> {
  const profile = await findProfile(workspaceId, instagramAccountId);
  if (!profile || !text.trim()) return null;
  const row = await prisma.aiFactCandidate.create({
    data: { workspaceId, profileId: profile.id, kind: "OTHER", title: text.trim().slice(0, 60), body: text.trim().slice(0, 2000), source: "manager_reply", evidence: by },
  });
  return row.id;
}
