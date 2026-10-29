import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { redeliverDead } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** Body optional: `{ integrationId }` limits it to one integration. */
export async function POST(request: NextRequest) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => ({}));
  return respond(await redeliverDead(auth.ctx.workspaceId, body && typeof body === "object" ? body : {}));
}
