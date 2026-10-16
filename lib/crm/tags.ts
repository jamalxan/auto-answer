/**
 * ETAP 5.1 — tags (TZ 28): CRUD per workspace, manual / AI / automation
 * tags on contacts, and the automatic tagging listener.
 *
 * Automatic tags (origin AUTOMATION / AI), from the CRM events the sync
 * layer emits (lib/crm/hooks registerCrmListener):
 *   campaign name   — the event carries a campaignId / claimedCampaignId
 *   "reklama"       — the event carries an adId (click-to-Direct ad)
 *   "havola:<ref>"  — the event carries an ig.me ref
 *   "handoff"       — HANDOFF_OPENED
 *   hot / iliq / sovuq — the temperature band on TEMPERATURE_CHANGED (the
 *                     previous band tag is removed; CUSTOMER / LOST clear it)
 *   "mahsulot:<slug>" / "joy:<slug>" — AiConversationState.extracted product
 *                     and location, re-read on score / temperature / lead
 *                     events (origin AI, sourceRef "ai:extracted.<key>")
 *
 * Every tag may be removed by hand; the origin is recorded on the link so the
 * UI can show where it came from. Slugs are unique per workspace
 * (defaults.tagSlug); automatic tags are created lazily with an Uzbek name.
 */

import { z } from "zod";
import type { CrmActorKind, CrmTagOrigin, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { emitContactTagged } from "@/lib/integrations2/emit";
import { recordActivity } from "./activity";
import { DEFAULT_TAGS, tagSlug } from "./defaults";
import { isUniqueViolation, notFound, unprocessable } from "./errors";
import { registerCrmListener, type CrmEvent } from "./hooks";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const COLOR = /^#[0-9a-fA-F]{6}$/;

export const tagInputSchema = z.object({
  name: z.string().trim().min(1, "Teg nomi kiritilmagan").max(40, "Teg nomi 40 belgidan oshmasin"),
  color: z.string().regex(COLOR, "Rang #RRGGBB ko'rinishida bo'lsin").nullable().optional(),
});
export type TagInput = z.infer<typeof tagInputSchema>;

export const tagUpdateSchema = tagInputSchema.partial();
export type TagUpdate = z.infer<typeof tagUpdateSchema>;

export const TAG_NOT_FOUND = "Teg topilmadi";
export const CONTACT_NOT_FOUND = "Kontakt topilmadi";
export const TAG_EXISTS = "Bunday teg allaqachon mavjud";
export const TAG_NAME_INVALID = "Teg nomi harf yoki raqam bo'lishi kerak";

const ACTOR_OF_ORIGIN: Record<CrmTagOrigin, CrmActorKind> = {
  MANUAL: "OPERATOR",
  AI: "AI",
  AUTOMATION: "AUTOMATION",
  SYSTEM: "SYSTEM",
};

export interface TagSummary {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  contactCount: number;
  createdAt: Date;
}

export interface ContactTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  origin: CrmTagOrigin;
  sourceRef: string | null;
  createdAt: Date;
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listTags(workspaceId: string): Promise<TagSummary[]> {
  const rows = await prisma.crmTag.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    include: { _count: { select: { contacts: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color ?? null,
    contactCount: row._count.contacts,
    createdAt: row.createdAt,
  }));
}

export async function createTag(workspaceId: string, input: unknown) {
  const parsed = tagInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const slug = tagSlug(parsed.data.name);
  if (!slug) throw unprocessable(TAG_NAME_INVALID);
  const existing = await prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
  if (existing) throw unprocessable(TAG_EXISTS);
  try {
    return await prisma.crmTag.create({
      data: { workspaceId, name: parsed.data.name, slug, color: parsed.data.color ?? null },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw unprocessable(TAG_EXISTS);
    throw error;
  }
}

export async function updateTag(workspaceId: string, tagId: string, input: unknown) {
  const parsed = tagUpdateSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const tag = await prisma.crmTag.findFirst({ where: { id: tagId, workspaceId } });
  if (!tag) throw notFound(TAG_NOT_FOUND);
  const data: Prisma.CrmTagUpdateInput = {};
  if (parsed.data.name !== undefined && parsed.data.name !== tag.name) {
    const slug = tagSlug(parsed.data.name);
    if (!slug) throw unprocessable(TAG_NAME_INVALID);
    if (slug !== tag.slug) {
      const clash = await prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
      if (clash && clash.id !== tag.id) throw unprocessable(TAG_EXISTS);
    }
    data.name = parsed.data.name;
    data.slug = slug;
  }
  if (parsed.data.color !== undefined) data.color = parsed.data.color;
  if (Object.keys(data).length === 0) return tag;
  return prisma.crmTag.update({ where: { id: tag.id }, data });
}

/** Removes the tag and every contact link (the FK cascades too; explicit for clarity). */
export async function deleteTag(workspaceId: string, tagId: string): Promise<void> {
  const tag = await prisma.crmTag.findFirst({ where: { id: tagId, workspaceId } });
  if (!tag) throw notFound(TAG_NOT_FOUND);
  await prisma.crmContactTag.deleteMany({ where: { tagId: tag.id } });
  await prisma.crmTag.delete({ where: { id: tag.id } });
}

/** Lazy seed of DEFAULT_TAGS; creates only the slugs that are missing. Returns how many were created. */
export async function ensureDefaultTags(workspaceId: string): Promise<number> {
  const existing = await prisma.crmTag.findMany({ where: { workspaceId }, select: { slug: true } });
  const have = new Set(existing.map((row) => row.slug));
  const missing = DEFAULT_TAGS.filter((tag) => !have.has(tag.slug));
  if (missing.length === 0) return 0;
  await prisma.crmTag.createMany({
    data: missing.map((tag) => ({ workspaceId, name: tag.name, slug: tag.slug, color: tag.color })),
    skipDuplicates: true,
  });
  return missing.length;
}

/** Tag by id or slug, scoped to the workspace. */
export async function findTag(workspaceId: string, tagIdOrSlug: string) {
  const byId = await prisma.crmTag.findFirst({ where: { id: tagIdOrSlug, workspaceId } });
  if (byId) return byId;
  const slug = tagIdOrSlug.includes(":") ? tagIdOrSlug : tagSlug(tagIdOrSlug);
  if (!slug) return null;
  return prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
}

/** Find-or-create by slug (automatic tags). The name is only used on creation. */
export async function ensureTag(workspaceId: string, name: string, slug = tagSlug(name), color: string | null = null) {
  if (!slug) throw unprocessable(TAG_NAME_INVALID);
  const existing = await prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
  if (existing) return existing;
  try {
    return await prisma.crmTag.create({ data: { workspaceId, name: name.slice(0, 40), slug, color } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
    if (!raced) throw error;
    return raced;
  }
}

// ─── Contact ↔ tag ────────────────────────────────────────────────────────────

export interface TagChange {
  changed: boolean;
  tag: { id: string; name: string; slug: string; color: string | null };
}

/**
 * Links the tag to the contact (idempotent: a second call is a no-op) and
 * writes a TAG_ADDED activity for a real change.
 */
export async function addTag(
  workspaceId: string,
  contactId: string,
  tagIdOrSlug: string,
  origin: CrmTagOrigin,
  sourceRef?: string | null,
  actorMemberId?: string | null
): Promise<TagChange> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } });
  if (!contact) throw notFound(CONTACT_NOT_FOUND);
  const tag = await findTag(workspaceId, tagIdOrSlug);
  if (!tag) throw notFound(TAG_NOT_FOUND);

  const existing = await prisma.crmContactTag.findUnique({ where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } } });
  if (existing) return { changed: false, tag };
  try {
    await prisma.crmContactTag.create({ data: { contactId: contact.id, tagId: tag.id, origin, sourceRef: sourceRef ?? null } });
  } catch (error) {
    if (isUniqueViolation(error)) return { changed: false, tag };
    throw error;
  }
  await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: "TAG_ADDED",
    occurredAt: new Date(),
    actorKind: ACTOR_OF_ORIGIN[origin],
    actorMemberId: actorMemberId ?? null,
    title: `Teg qo'shildi: ${tag.name}`,
    payload: { tagId: tag.id, slug: tag.slug, name: tag.name, origin, sourceRef: sourceRef ?? null },
  });
  void emitContactTagged(workspaceId, contact.id, tag.slug);
  return { changed: true, tag };
}

/** Unlinks the tag (any origin — manual removal is always allowed) with a TAG_REMOVED activity. */
export async function removeTag(
  workspaceId: string,
  contactId: string,
  tagIdOrSlug: string,
  actorMemberId?: string | null,
  actorKind: CrmActorKind = "OPERATOR"
): Promise<TagChange> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } });
  if (!contact) throw notFound(CONTACT_NOT_FOUND);
  const tag = await findTag(workspaceId, tagIdOrSlug);
  if (!tag) throw notFound(TAG_NOT_FOUND);

  const removed = await prisma.crmContactTag.deleteMany({ where: { contactId: contact.id, tagId: tag.id } });
  if (removed.count === 0) return { changed: false, tag };
  await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: "TAG_REMOVED",
    occurredAt: new Date(),
    actorKind,
    actorMemberId: actorMemberId ?? null,
    title: `Teg olib tashlandi: ${tag.name}`,
    payload: { tagId: tag.id, slug: tag.slug, name: tag.name },
  });
  return { changed: true, tag };
}

export async function tagsOfContact(contactId: string): Promise<ContactTag[]> {
  const rows = await prisma.crmContactTag.findMany({
    where: { contactId },
    include: { tag: true },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((row) => row.tag)
    .map((row) => ({
      id: row.tag.id,
      name: row.tag.name,
      slug: row.tag.slug,
      color: row.tag.color ?? null,
      origin: row.origin,
      sourceRef: row.sourceRef ?? null,
      createdAt: row.createdAt,
    }));
}

// ─── Automatic tags ───────────────────────────────────────────────────────────

/** Fixed automatic tags, in Uzbek. Slugs are what segments filter on. */
export const AUTO_TAGS = {
  reklama: { name: "Reklama", slug: "reklama", color: "#EC4899" },
  handoff: { name: "Operatorga o'tgan", slug: "handoff", color: "#F97316" },
} as const;

/** Temperature band → tag; CUSTOMER / LOST carry no band tag. */
export const TEMPERATURE_TAGS: Record<string, { name: string; slug: string; color: string }> = {
  HOT: { name: "HOT", slug: "hot", color: "#EF4444" },
  WARM: { name: "ILIQ", slug: "iliq", color: "#F59E0B" },
  COLD: { name: "SOVUQ", slug: "sovuq", color: "#64748B" },
};
const BAND_SLUGS = Object.values(TEMPERATURE_TAGS).map((tag) => tag.slug);

export const PRODUCT_TAG_PREFIX = "mahsulot";
export const LOCATION_TAG_PREFIX = "joy";
export const LINK_TAG_PREFIX = "havola";

/** "mahsulot" + "IELTS kursi" → { name: "Mahsulot: IELTS kursi", slug: "mahsulot:ielts-kursi" }. */
export function namespacedTag(prefix: string, value: string, label = prefix): { name: string; slug: string } | null {
  const slug = tagSlug(value);
  if (!slug) return null;
  const title = label.charAt(0).toUpperCase() + label.slice(1);
  return { name: `${title}: ${value.trim()}`.slice(0, 40), slug: `${prefix}:${slug}` };
}

async function addAutoTag(
  workspaceId: string,
  contactId: string,
  tag: { name: string; slug: string; color?: string | null },
  origin: CrmTagOrigin,
  sourceRef: string | null
): Promise<boolean> {
  const row = await ensureTag(workspaceId, tag.name, tag.slug, tag.color ?? null);
  const change = await addTag(workspaceId, contactId, row.id, origin, sourceRef);
  return change.changed;
}

/** Replaces the band tag (hot / iliq / sovuq) with the one for `temperature`. */
export async function applyTemperatureTag(workspaceId: string, contactId: string, temperature: string | null | undefined): Promise<void> {
  const wanted = temperature ? TEMPERATURE_TAGS[temperature] : undefined;
  const current = await tagsOfContact(contactId);
  for (const tag of current) {
    if (BAND_SLUGS.includes(tag.slug) && tag.slug !== wanted?.slug) {
      await removeTag(workspaceId, contactId, tag.id, null, "AI");
    }
  }
  if (wanted) await addAutoTag(workspaceId, contactId, wanted, "AI", "ai:temperature");
}

/** "mahsulot:<slug>" / "joy:<slug>" from JavobAI's extracted fields (AiConversationState.extracted). */
export async function applyExtractedTags(workspaceId: string, contactId: string, extracted: Record<string, unknown> | null | undefined): Promise<void> {
  if (!extracted || typeof extracted !== "object") return;
  const product = typeof extracted.product === "string" ? extracted.product.trim() : "";
  const location = typeof extracted.location === "string" ? extracted.location.trim() : "";
  if (product) {
    const tag = namespacedTag(PRODUCT_TAG_PREFIX, product.slice(0, 60));
    if (tag) await addAutoTag(workspaceId, contactId, tag, "AI", "ai:extracted.product");
  }
  if (location) {
    const tag = namespacedTag(LOCATION_TAG_PREFIX, location.slice(0, 60));
    if (tag) await addAutoTag(workspaceId, contactId, tag, "AI", "ai:extracted.location");
  }
}

export interface AutomationTagFacts {
  campaignId?: string | null;
  campaignName?: string | null;
  adId?: string | null;
  ref?: string | null;
}

/** Campaign / ad / link tags from the facts of an event (origin AUTOMATION). */
export async function applyAutomationTags(workspaceId: string, contactId: string, facts: AutomationTagFacts): Promise<void> {
  if (facts.campaignId) {
    let name = facts.campaignName?.trim() || "";
    if (!name) {
      const campaign = await prisma.triggerCampaign.findFirst({ where: { id: facts.campaignId, workspaceId }, select: { name: true } });
      name = campaign?.name?.trim() ?? "";
    }
    const slug = tagSlug(name);
    if (slug) await addAutoTag(workspaceId, contactId, { name, slug }, "AUTOMATION", `campaign:${facts.campaignId}`);
  }
  if (facts.adId) await addAutoTag(workspaceId, contactId, AUTO_TAGS.reklama, "AUTOMATION", `ad:${facts.adId}`);
  // "rf_<code>" refs are referral links (ETAP 9): a code is not a campaign link, so no "havola:" tag.
  if (facts.ref && !facts.ref.toLowerCase().startsWith("rf_")) {
    const tag = namespacedTag(LINK_TAG_PREFIX, facts.ref.slice(0, 60));
    if (tag) await addAutoTag(workspaceId, contactId, tag, "AUTOMATION", `ref:${facts.ref}`);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Facts an interaction payload may carry (the sync layer mirrors InstagramEvent / TriggerExecution columns). */
export function automationFactsOf(payload: Record<string, unknown> | null | undefined): AutomationTagFacts {
  if (!payload) return {};
  return {
    campaignId: str(payload.campaignId) ?? str(payload.claimedCampaignId),
    campaignName: str(payload.campaignName),
    adId: str(payload.adId),
    ref: str(payload.ref),
  };
}

/**
 * The listener (lib/crm/hooks CrmEvent):
 *   interaction   — campaign / ad / link facts in `payload`
 *                   (campaignId | claimedCampaignId, campaignName, adId, ref)
 *   handoff       — "handoff" on HANDOFF_OPENED
 *   score         — temperature band when it changed, plus extracted tags
 *   lead_created  — extracted tags (product / location) at lead time
 * Exported so the worker / tests can call it directly.
 */
export async function onCrmEventForTags(event: CrmEvent): Promise<void> {
  switch (event.kind) {
    case "interaction": {
      const facts = automationFactsOf(event.payload);
      if (facts.campaignId || facts.adId || facts.ref) await applyAutomationTags(event.workspaceId, event.contactId, facts);
      return;
    }
    case "handoff":
      if (event.state === "HANDOFF_OPENED") {
        await addAutoTag(event.workspaceId, event.contactId, AUTO_TAGS.handoff, "AUTOMATION", `handoff:${event.handoffId}`);
      }
      return;
    case "score":
      if (event.temperature !== event.previousTemperature) {
        await applyTemperatureTag(event.workspaceId, event.contactId, event.temperature);
      }
      await applyExtractedTags(event.workspaceId, event.contactId, await loadExtracted(event.contact.conversationId));
      return;
    case "lead_created":
      await applyExtractedTags(event.workspaceId, event.contactId, await loadExtracted(event.contact.conversationId));
      return;
    default:
      return;
  }
}

async function loadExtracted(conversationId: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!conversationId) return null;
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId }, select: { extracted: true } });
  const extracted = state?.extracted;
  return extracted && typeof extracted === "object" && !Array.isArray(extracted) ? (extracted as Record<string, unknown>) : null;
}

/** Wires the listener (idempotent: the registry is a Set); importing this module does it too (the worker imports lib/crm/tags). */
export function registerTagListeners(): void {
  registerCrmListener(onCrmEventForTags);
}

registerTagListeners();
