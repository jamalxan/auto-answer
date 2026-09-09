"use server";

import { revalidatePath } from "next/cache";
import { getAdminSession } from "@/lib/admin/auth";
import { prisma } from "@/lib/db/client";
import { invalidateActivePricingPlansCache } from "@/lib/pricing";
import type { Locale } from "@/lib/i18n/config";
import type { Prisma } from "@/app/generated/prisma/client";

async function requireAdmin(): Promise<void> {
  const session = await getAdminSession();
  if (!session) {
    throw new Error("Not authorized");
  }
}

/**
 * Toggle a workspace's platform-admin suspension flag. Re-checks the admin
 * session server-side rather than trusting the page that rendered the
 * button — a server action is a public endpoint like any other route.
 */
export async function setWorkspaceSuspended(formData: FormData): Promise<void> {
  await requireAdmin();

  const workspaceId = String(formData.get("workspaceId") ?? "");
  const suspend = formData.get("suspend") === "true";
  if (!workspaceId) {
    throw new Error("Missing workspaceId");
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      isSuspended: suspend,
      suspendedAt: suspend ? new Date() : null,
    },
  });

  revalidatePath("/admin/workspaces");
}

const LOCALES: Locale[] = ["uz", "ru", "en"];

/**
 * Create or update a landing-page pricing plan (create when no `id` is
 * present). This is marketing copy, not a billed plan — see lib/pricing.ts.
 * The form posts plain per-locale fields (name_uz, description_uz,
 * features_uz — one feature per line — repeated for ru/en); this builds the
 * PricingPlanContent JSON from those rather than asking the admin to type
 * JSON by hand.
 */
export async function savePricingPlan(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const priceAmount = Number.parseInt(String(formData.get("priceAmount") ?? "0"), 10);
  const priceCurrency = String(formData.get("priceCurrency") ?? "$").trim() || "$";
  const priceSuffix = String(formData.get("priceSuffix") ?? "/mo").trim();
  const sortOrder = Number.parseInt(String(formData.get("sortOrder") ?? "0"), 10);
  const isFeatured = formData.get("isFeatured") === "on";
  const isActive = formData.get("isActive") === "on";

  const content: Record<Locale, { name: string; description: string; features: string[] }> = {
    uz: { name: "", description: "", features: [] },
    ru: { name: "", description: "", features: [] },
    en: { name: "", description: "", features: [] },
  };
  for (const locale of LOCALES) {
    content[locale] = {
      name: String(formData.get(`name_${locale}`) ?? "").trim(),
      description: String(formData.get(`description_${locale}`) ?? "").trim(),
      features: String(formData.get(`features_${locale}`) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    };
  }

  const data = {
    priceAmount: Number.isFinite(priceAmount) ? priceAmount : 0,
    priceCurrency,
    priceSuffix,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    isFeatured,
    isActive,
    content: content as unknown as Prisma.InputJsonValue,
  };

  if (id) {
    await prisma.pricingPlan.update({ where: { id }, data });
  } else {
    if (!slug) {
      throw new Error("A new plan needs a slug (e.g. \"pro\")");
    }
    await prisma.pricingPlan.create({ data: { slug, ...data } });
  }

  revalidatePath("/admin/pricing");
  revalidatePath("/");
  invalidateActivePricingPlansCache();
}

export async function deletePricingPlan(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = String(formData.get("id") ?? "");
  if (!id) {
    throw new Error("Missing id");
  }

  await prisma.pricingPlan.delete({ where: { id } });

  revalidatePath("/admin/pricing");
  revalidatePath("/");
  invalidateActivePricingPlansCache();
}
