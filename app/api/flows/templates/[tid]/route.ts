import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { deleteTemplate, run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ tid: string }> };

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { tid } = await params;
  const result = await run(() => deleteTemplate(auth.ctx.workspaceId, tid));
  if (!result.ok) return respond(result);
  return jsonOk({ deleted: true });
}
