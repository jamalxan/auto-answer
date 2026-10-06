import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await prisma.knowledgeGap.updateMany({
    where: { id, workspaceId: auth.ctx.workspaceId },
    data: { status: "IGNORED" },
  });
  return result.count ? jsonOk({ ignored: true }) : jsonError("Not found", 404);
}
