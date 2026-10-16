import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { previewEventPayload } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** `?type=lead.created&leadId=...` builds the payload of a real lead; without leadId it is the documented sample. */
export async function GET(request: NextRequest) {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  const params = request.nextUrl.searchParams;
  return respond(
    await previewEventPayload(auth.ctx.workspaceId, {
      type: params.get("type") ?? undefined,
      leadId: params.get("leadId") ?? undefined,
    })
  );
}
