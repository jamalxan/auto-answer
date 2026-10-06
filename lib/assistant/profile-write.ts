/**
 * Writing the assistant profile — used by both the panel API and the Telegram
 * bot, so every change lands in `profile_change_log` with its source.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { ParsedProduct } from "./products-parse";
import { looksLikeInstruction, MAX_PROFILE_CHARS, profileCharCount } from "./prompt";

export type ChangeSource = "PANEL" | "TELEGRAM";

export interface ProfileFields {
  companyName?: string;
  description?: string;
  pricePolicy?: "NEVER" | "FROM_ONLY" | "EXACT";
  tone?: "FRIENDLY" | "FORMAL";
  personaName?: string | null;
  extraFieldLabel?: string | null;
  finalMessageTemplate?: string | null;
  handleCampaignReplies?: boolean;
  handleInboundDm?: boolean;
  operatorPauseHours?: number;
  maxBotMessages?: number;
  fallbackLeadWithoutPhone?: boolean;
  postHandoffReply?: boolean;
  workingHours?: Prisma.InputJsonValue | null;
  offHoursMessage?: string | null;
  address?: string | null;
  branches?: Prisma.InputJsonValue | null;
  delivery?: string | null;
  paymentMethods?: string[];
  categories?: Array<{ name: string; note?: string }>;
  priceReminderEnabled?: boolean;
  languageDefault?: string;
}

const JSON_FIELDS = new Set(["workingHours", "branches", "categories"]);

function same(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Validate the 6 000-character budget (TZ 3.3). Returns an error key or null. */
export function validateProfileSize(fields: {
  companyName: string;
  description: string;
  categories: Array<{ name: string; note?: string }>;
  faqs: Array<{ question: string; answer: string }>;
  address?: string | null;
  delivery?: string | null;
  workingHours?: string | null;
}): string | null {
  const count = profileCharCount({
    companyName: fields.companyName,
    description: fields.description,
    categories: fields.categories,
    faqs: fields.faqs,
    address: fields.address ?? null,
    delivery: fields.delivery ?? null,
    workingHours: fields.workingHours ?? null,
  });
  return count > MAX_PROFILE_CHARS ? "profile_too_long" : null;
}

export async function ensureProfile(
  workspaceId: string,
  instagramAccountId: string | null
) {
  const existing = await prisma.assistantProfile.findFirst({
    where: { workspaceId, instagramAccountId },
  });
  if (existing) return existing;
  return prisma.assistantProfile.create({
    data: { workspaceId, instagramAccountId },
  });
}

/** Patch profile fields and log every field that actually changed. */
export async function updateProfileFields(
  profileId: string,
  fields: ProfileFields,
  source: ChangeSource,
  actorUserId: string | null,
  extraData: Prisma.AssistantProfileUpdateInput = {}
) {
  const current = await prisma.assistantProfile.findUniqueOrThrow({ where: { id: profileId } });
  const data: Record<string, unknown> = {};
  const logs: Prisma.ProfileChangeLogCreateManyInput[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const before = (current as unknown as Record<string, unknown>)[key];
    if (same(before, value)) continue;
    data[key] = JSON_FIELDS.has(key) && value === null ? undefined : value;
    logs.push({
      profileId,
      source,
      actorUserId,
      field: key,
      oldValue: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      newValue: (value ?? undefined) as Prisma.InputJsonValue | undefined,
    });
  }

  const updated = await prisma.assistantProfile.update({
    where: { id: profileId },
    data: { ...(data as Prisma.AssistantProfileUpdateInput), ...extraData, source },
  });
  if (logs.length) await prisma.profileChangeLog.createMany({ data: logs });
  return updated;
}

function toProductRow(profileId: string, product: ParsedProduct, sort: number) {
  return {
    profileId,
    name: product.name,
    note: product.note,
    price: product.price,
    priceIsFrom: product.priceIsFrom,
    currency: product.currency,
    unit: product.unit,
    sort,
    priceUpdatedAt: new Date(),
  };
}

/** Replace or extend the product list; logs one entry with counts. */
export async function saveProducts(
  profileId: string,
  products: ParsedProduct[],
  mode: "replace" | "add",
  source: ChangeSource,
  actorUserId: string | null
) {
  const before = await prisma.assistantProduct.count({ where: { profileId } });
  if (mode === "replace") {
    await prisma.assistantProduct.deleteMany({ where: { profileId } });
  }
  const start = mode === "replace" ? 0 : before;
  if (products.length) {
    await prisma.assistantProduct.createMany({
      data: products.slice(0, 200 - (mode === "add" ? before : 0)).map((p, i) => toProductRow(profileId, p, start + i)),
    });
  }
  const after = await prisma.assistantProduct.count({ where: { profileId } });
  await prisma.profileChangeLog.create({
    data: {
      profileId,
      source,
      actorUserId,
      field: "products",
      oldValue: { count: before },
      newValue: { count: after, mode },
    },
  });
  return after;
}

export async function replaceFaqs(
  profileId: string,
  faqs: Array<{ question: string; answer: string }>,
  source: ChangeSource,
  actorUserId: string | null
) {
  await prisma.assistantFaq.deleteMany({ where: { profileId, source: "OWNER" } });
  if (faqs.length) {
    await prisma.assistantFaq.createMany({
      data: faqs.slice(0, 5).map((f, i) => ({ profileId, question: f.question, answer: f.answer, sort: i })),
    });
  }
  await prisma.profileChangeLog.create({
    data: { profileId, source, actorUserId, field: "faqs", newValue: { count: Math.min(faqs.length, 5) } },
  });
}

/** Free-text profile fields that look like instructions to the bot (warning in UI). */
export function findInstructionLikeFields(fields: {
  description?: string | null;
  address?: string | null;
  delivery?: string | null;
  faqs?: Array<{ question: string; answer: string }>;
  categories?: Array<{ name: string; note?: string }>;
}): string[] {
  const hits: string[] = [];
  if (fields.description && looksLikeInstruction(fields.description)) hits.push("description");
  if (fields.address && looksLikeInstruction(fields.address)) hits.push("address");
  if (fields.delivery && looksLikeInstruction(fields.delivery)) hits.push("delivery");
  if (fields.faqs?.some((f) => looksLikeInstruction(`${f.question} ${f.answer}`))) hits.push("faqs");
  if (fields.categories?.some((c) => looksLikeInstruction(`${c.name} ${c.note ?? ""}`))) hits.push("categories");
  return hits;
}

/** Approve the profile: assistant may go live. Requires the minimum fields. */
export async function approveProfile(
  profileId: string,
  source: ChangeSource,
  actorUserId: string | null,
  enable = true
) {
  const profile = await prisma.assistantProfile.findUniqueOrThrow({
    where: { id: profileId },
    include: { _count: { select: { products: true } } },
  });
  const categories = Array.isArray(profile.categories) ? profile.categories : [];
  if (!profile.companyName.trim() || !profile.description.trim()) {
    throw new Error("profile_incomplete");
  }
  if (profile._count.products === 0 && categories.length === 0) {
    throw new Error("profile_incomplete");
  }
  const updated = await prisma.assistantProfile.update({
    where: { id: profileId },
    data: { approvedAt: new Date(), enabled: enable, source },
  });
  await prisma.profileChangeLog.create({
    data: { profileId, source, actorUserId, field: "approved", newValue: { enabled: enable } },
  });
  return updated;
}
