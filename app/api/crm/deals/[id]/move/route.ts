import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { actorOf, moveDeal, moveDealSchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Drag in the Kanban / Won / Lost (with reason). OPERATOR+ (assign_leads). */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("assign_leads", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(moveDealSchema, body);
  if (!parsed.ok) return respond(parsed);
  const actor = await actorOf(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role);
  return respond(
    await moveDeal(
      auth.ctx.workspaceId,
      id,
      parsed.data.stageId,
      { kind: "OPERATOR", memberId: actor.memberId },
      { lostReason: parsed.data.lostReason ?? null }
    )
  );
}
