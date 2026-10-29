import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { actorOf, removeTag, run, tagsOfContact } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; tagId: string }> };

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("assign_leads", { write: true });
  if (!auth.ok) return auth.response;
  const { id, tagId } = await params;
  const actor = await actorOf(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role);
  const result = await run(() => removeTag(auth.ctx.workspaceId, id, tagId, actor.memberId));
  if (!result.ok) return respond(result);
  return jsonOk({ ...result.data, tags: await tagsOfContact(id) });
}
