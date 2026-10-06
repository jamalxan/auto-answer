import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const patchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  note: z.string().max(200).nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  priceIsFrom: z.boolean().optional(),
  currency: z.enum(["UZS", "USD", "RUB"]).optional(),
  unit: z.string().max(30).nullable().optional(),
});

async function ownedProduct(id: string, workspaceId: string) {
  return prisma.assistantProduct.findFirst({ where: { id, profile: { workspaceId } } });
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const parsed = patchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);
  const existing = await ownedProduct(id, auth.ctx.workspaceId);
  if (!existing) return jsonError("Not found", 404);

  const priceChanged =
    parsed.data.price !== undefined &&
    (existing.price === null ? null : Number(existing.price)) !== parsed.data.price;
  const product = await prisma.assistantProduct.update({
    where: { id },
    data: { ...parsed.data, ...(priceChanged ? { priceUpdatedAt: new Date() } : {}) },
  });
  return jsonOk({
    product: { ...product, price: product.price === null ? null : Number(product.price) },
  });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!(await ownedProduct(id, auth.ctx.workspaceId))) return jsonError("Not found", 404);
  await prisma.assistantProduct.delete({ where: { id } });
  return jsonOk({ deleted: true });
}
