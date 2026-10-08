import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { findProfile } from "@/lib/assistant/profile";
import {
  ensureProfile,
  replaceFaqs,
  saveProducts,
  updateProfileFields,
  validateProfileSize,
} from "@/lib/assistant/profile-write";
import { MAX_PROFILE_CHARS } from "@/lib/assistant/prompt";
import { serializeProfile } from "@/lib/assistant/serialize";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const accountId = request.nextUrl.searchParams.get("instagramAccountId") || null;

  const profile = await findProfile(auth.ctx.workspaceId, accountId);
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: auth.ctx.workspaceId },
    select: { id: true, username: true },
    orderBy: { connectedAt: "asc" },
  });
  return jsonOk({
    profile: profile ? serializeProfile(profile) : null,
    accounts,
    canManage: auth.ctx.role !== "MEMBER",
  });
}

const workingHoursSchema = z
  .object({
    text: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    from: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
    to: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
    tzOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  })
  .nullable();

const productSchema = z.object({
  name: z.string().min(1).max(120),
  note: z.string().max(200).nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  priceIsFrom: z.boolean().optional(),
  currency: z.enum(["UZS", "USD", "RUB"]).optional(),
  unit: z.string().max(30).nullable().optional(),
});

const bodySchema = z.object({
  instagramAccountId: z.string().nullable().optional(),
  companyName: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  pricePolicy: z.enum(["NEVER", "FROM_ONLY", "EXACT"]).optional(),
  tone: z.enum(["FRIENDLY", "FORMAL"]).optional(),
  personaName: z.string().max(40).nullable().optional(),
  extraFieldLabel: z.string().max(60).nullable().optional(),
  finalMessageTemplate: z.string().max(300).nullable().optional(),
  handleCampaignReplies: z.boolean().optional(),
  handleInboundDm: z.boolean().optional(),
  operatorPauseHours: z.number().int().min(1).max(72).optional(),
  maxBotMessages: z.number().int().min(2).max(12).optional(),
  fallbackLeadWithoutPhone: z.boolean().optional(),
  postHandoffReply: z.boolean().optional(),
  workingHours: workingHoursSchema.optional(),
  offHoursMessage: z.string().max(300).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  delivery: z.string().max(200).nullable().optional(),
  paymentMethods: z.array(z.string().max(40)).max(10).optional(),
  categories: z
    .array(z.object({ name: z.string().min(1).max(80), note: z.string().max(160).optional() }))
    .max(30)
    .optional(),
  priceReminderEnabled: z.boolean().optional(),
  learningEnabled: z.boolean().optional(),
  learnedStyle: z.string().max(2500).nullable().optional(),
  learnedExamples: z
    .array(z.object({ customer: z.string().min(1).max(200), reply: z.string().min(1).max(300) }))
    .max(8)
    .optional(),
  products: z.array(productSchema).max(200).optional(),
  faqs: z.array(z.object({ question: z.string().min(1).max(200), answer: z.string().min(1).max(400) })).max(5).optional(),
});

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400, { issues: parsed.error.issues });
  const { instagramAccountId = null, products, faqs, ...fields } = parsed.data;

  if (instagramAccountId) {
    const owns = await prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId: auth.ctx.workspaceId },
      select: { id: true },
    });
    if (!owns) return jsonError("Instagram account not found", 404);
  }

  const profile = await ensureProfile(auth.ctx.workspaceId, instagramAccountId);
  const merged = {
    companyName: fields.companyName ?? profile.companyName,
    description: fields.description ?? profile.description,
    categories: fields.categories ?? (Array.isArray(profile.categories) ? (profile.categories as Array<{ name: string; note?: string }>) : []),
    faqs: faqs ?? (await prisma.assistantFaq.findMany({ where: { profileId: profile.id } })),
    address: fields.address ?? profile.address,
    delivery: fields.delivery ?? profile.delivery,
    workingHours: fields.workingHours?.text ?? null,
  };
  if (validateProfileSize(merged)) {
    return jsonError("Profile text is too long", 422, { code: "profile_too_long", limit: MAX_PROFILE_CHARS });
  }

  await updateProfileFields(
    profile.id,
    { ...fields, workingHours: fields.workingHours as never },
    "PANEL",
    auth.ctx.userId
  );
  if (products) {
    await saveProducts(
      profile.id,
      products.map((p) => ({
        name: p.name,
        note: p.note ?? null,
        price: p.price ?? null,
        priceIsFrom: p.priceIsFrom ?? false,
        currency: p.currency ?? "UZS",
        unit: p.unit ?? null,
        priceUnclear: false,
      })),
      "replace",
      "PANEL",
      auth.ctx.userId
    );
  }
  if (faqs) await replaceFaqs(profile.id, faqs, "PANEL", auth.ctx.userId);

  const fresh = await findProfile(auth.ctx.workspaceId, instagramAccountId);
  return jsonOk({ profile: fresh ? serializeProfile(fresh) : null });
}
