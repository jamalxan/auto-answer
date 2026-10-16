import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { NOT_JSON, readJson, requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { putSubscriptions } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Replaces the subscription set of the integration. */
export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError(NOT_JSON, 400);
  return respond(await putSubscriptions(auth.ctx.workspaceId, id, body));
}
