import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { z } from "zod";
import { run, setMemberRole } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ memberId: string }> };

const bodySchema = z.object({ role: z.string().min(1, "Rol tanlanmagan") });

/** OWNER / ADMIN only (lib/crm/team.ts enforces who may change whom). */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts", { write: true });
  if (!auth.ok) return auth.response;
  const { memberId } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(bodySchema, body);
  if (!parsed.ok) return respond(parsed);
  const result = await run(() => setMemberRole(auth.ctx.workspaceId, auth.ctx.role, memberId, parsed.data.role));
  if (!result.ok) return respond(result);
  return jsonOk({ member: { id: result.data.id, role: result.data.role } });
}
