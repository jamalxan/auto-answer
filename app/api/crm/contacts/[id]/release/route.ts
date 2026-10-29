import { NextRequest } from "next/server";
import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { actorOf, releaseContactAs } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Operators release their own contact; MANAGER+ anyone's. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("assign_leads", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const actor = await actorOf(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role);
  return respond(await releaseContactAs(auth.ctx.workspaceId, id, actor));
}
