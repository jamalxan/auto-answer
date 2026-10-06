import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { runConnectionCheck } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ param: string }> };

/** "Ulanishni tekshirish": a real API request. A repaired integration resumes held leads. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { param: id } = await params;
  const integration = await prisma.integration.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    select: { id: true },
  });
  if (!integration) return jsonError("Not found", 404);

  const result = await runConnectionCheck(id);
  return jsonOk(result);
}
