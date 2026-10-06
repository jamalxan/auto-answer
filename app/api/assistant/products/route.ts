import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { ensureProfile } from "@/lib/assistant/profile-write";
import { findProfile } from "@/lib/assistant/profile";

export const dynamic = "force-dynamic";

const productBody = z.object({
  instagramAccountId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
  note: z.string().max(200).nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  priceIsFrom: z.boolean().optional(),
  currency: z.enum(["UZS", "USD", "RUB"]).optional(),
  unit: z.string().max(30).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const profile = await findProfile(
    auth.ctx.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId") || null
  );
  return jsonOk({
    products: (profile?.products ?? []).map((p) => ({
      ...p,
      price: p.price === null ? null : Number(p.price),
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const parsed = productBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const { instagramAccountId, ...data } = parsed.data;
  const profile = await ensureProfile(auth.ctx.workspaceId, instagramAccountId ?? null);
  const count = await prisma.assistantProduct.count({ where: { profileId: profile.id } });
  if (count >= 200) return jsonError("At most 200 products", 422, { code: "too_many_products" });

  const product = await prisma.assistantProduct.create({
    data: { ...data, profileId: profile.id, sort: count, priceUpdatedAt: new Date() },
  });
  return jsonOk(
    { product: { ...product, price: product.price === null ? null : Number(product.price) } },
    201
  );
}
