import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { redeliverLead } from "@/lib/leads/delivery";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** "Qayta yuborish": re-queue every failed / dead delivery of this lead. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const lead = await prisma.lead.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    select: { id: true },
  });
  if (!lead) return jsonError("Not found", 404);

  const queued = await redeliverLead(id);
  return jsonOk({ queued });
}
