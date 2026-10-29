import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { saveStages, stagesSchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Replace the stage list: rename / reorder / add / kind / colour / entry; a stage with deals cannot be deleted (422). */
export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(stagesSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await saveStages(auth.ctx.workspaceId, id, parsed.data.stages));
}
