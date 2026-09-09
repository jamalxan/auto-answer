"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { prisma } from "@/lib/db/client";
import { invalidateActivePricingPlansCache } from "@/lib/pricing";
import type { Prisma } from "@/app/generated/prisma/client";

async function requireAdmin() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    throw new Error("Not authorized");
  }
}

/**
 * Toggle a workspace's platform-admin suspension flag. Re-checks admin
 * status server-side rather than trusting the page that rendered the
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

  revalidatePath("/admin");
}

/**
 * Create or update a landing-page pricing plan (create when no `id` is
 * present). This is marketing copy, not a billed plan — see lib/pricing.ts.
 * `content` arrives as pretty-printed JSON from the admin textarea; invalid
 * JSON fails loudly rather than silently corrupting the stored copy.
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
  const contentRaw = String(formData.get("content") ?? "{}");

  let content: Prisma.InputJsonValue;
  try {
    content = JSON.parse(contentRaw);
  } catch {
    throw new Error(
      "Pricing plan content is not valid JSON — the expected shape is " +
        '{ "en": { "name", "description", "features": [...] }, "ru": {...}, "uz": {...} }'
    );
  }

  const data = {
    priceAmount: Number.isFinite(priceAmount) ? priceAmount : 0,
    priceCurrency,
    priceSuffix,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    isFeatured,
    isActive,
    content,
  };

  if (id) {
    await prisma.pricingPlan.update({ where: { id }, data });
  } else {
    if (!slug) {
      throw new Error("A new plan needs a slug (e.g. \"pro\")");
    }
    await prisma.pricingPlan.create({ data: { slug, ...data } });
  }

  revalidatePath("/admin");
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

  revalidatePath("/admin");
  revalidatePath("/");
  invalidateActivePricingPlansCache();
}
