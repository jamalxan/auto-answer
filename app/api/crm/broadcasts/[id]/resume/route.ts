import { NextRequest } from "next/server";
import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { resumeBroadcast } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await resumeBroadcast(auth.ctx.workspaceId, id));
}
