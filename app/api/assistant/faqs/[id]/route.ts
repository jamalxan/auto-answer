import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const patchBody = z.object({
  question: z.string().min(1).max(200).optional(),
  answer: z.string().min(1).max(400).optional(),
});

async function ownedFaq(id: string, workspaceId: string) {
  return prisma.assistantFaq.findFirst({ where: { id, profile: { workspaceId } } });
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const parsed = patchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);
  if (!(await ownedFaq(id, auth.ctx.workspaceId))) return jsonError("Not found", 404);
  return jsonOk({ faq: await prisma.assistantFaq.update({ where: { id }, data: parsed.data }) });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!(await ownedFaq(id, auth.ctx.workspaceId))) return jsonError("Not found", 404);
  await prisma.assistantFaq.delete({ where: { id } });
  return jsonOk({ deleted: true });
}
