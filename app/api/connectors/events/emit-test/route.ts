import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { NOT_JSON, readJson, requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { emitTestEvent } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** A synthetic is_test event; only subscriptions with include_test receive it. */
export async function POST(request: NextRequest) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError(NOT_JSON, 400);
  return respond(await emitTestEvent(auth.ctx.workspaceId, body));
}
