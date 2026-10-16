import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireFlows, respond } from "@/lib/developer/flows-guard";
import { run, saveDraft } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => saveDraft(auth.ctx.workspaceId, id, body)));
}
