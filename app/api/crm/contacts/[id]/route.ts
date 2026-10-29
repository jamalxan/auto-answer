import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { actorOf, contactPatchSchema, getContactDetail, patchContact, timelineQuerySchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Contact + tags + the first timeline page (?before= &limit= page older items). */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const query = parseBody(timelineQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const result = await getContactDetail(auth.ctx.workspaceId, id, {
    before: query.data.before ? new Date(query.data.before) : null,
    limit: query.data.limit,
  });
  return respond(result);
}

/** status / customFields / name / email / language / optedOut. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("assign_leads", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(contactPatchSchema, body);
  if (!parsed.ok) return respond(parsed);
  const actor = await actorOf(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role);
  return respond(await patchContact(auth.ctx.workspaceId, id, parsed.data, actor));
}
