import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { actorOf, addTag, addTagSchema, run, tagsOfContact } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("assign_leads", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(addTagSchema, body);
  if (!parsed.ok) return respond(parsed);
  const actor = await actorOf(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role);
  const result = await run(() =>
    addTag(auth.ctx.workspaceId, id, parsed.data.tagId, "MANUAL", actor.memberId ? `member:${actor.memberId}` : null, actor.memberId)
  );
  if (!result.ok) return respond(result);
  return jsonOk({ ...result.data, tags: await tagsOfContact(id) }, result.data.changed ? 201 : 200);
}
