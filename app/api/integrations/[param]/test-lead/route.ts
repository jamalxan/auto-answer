import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { sendTestLead } from "@/lib/leads/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ param: string }> };

/** Sends a `[TEST]` lead through the normal delivery pipeline of one integration. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { param: id } = await params;
  const integration = await prisma.integration.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    select: { id: true, status: true },
  });
  if (!integration) return jsonError("Not found", 404);
  if (integration.status !== "ACTIVE") return jsonError("Integration is not active", 409, { code: "not_active" });

  try {
    const leadId = await sendTestLead(id);
    return jsonOk({ leadId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed", 422);
  }
}
