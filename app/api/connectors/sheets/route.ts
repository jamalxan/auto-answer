import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { NOT_JSON, readJson, requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { createSheetsIntegration } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** The service-account key is stored encrypted and never returned; only its client_email is. */
export async function POST(request: NextRequest) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError(NOT_JSON, 400);
  return respond(await createSheetsIntegration(auth.ctx.workspaceId, body), 201);
}
