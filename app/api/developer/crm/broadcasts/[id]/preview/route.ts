import { NextRequest } from "next/server";
import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { previewAudience } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await previewAudience(auth.ctx.workspaceId, { broadcastId: id }));
}
