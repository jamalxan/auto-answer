import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { IntegrationAuthError } from "@/lib/integrations/errors";
import { bitrixClientFromIntegration } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; resource: string }> };

/** Dropdown data for the Bitrix24 settings: responsible users and lead sources. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { id, resource } = await params;

  const integration = await prisma.integration.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId, type: "BITRIX24" },
  });
  if (!integration) return jsonError("Not found", 404);

  try {
    const client = bitrixClientFromIntegration(integration);
    if (resource === "users") return jsonOk({ items: await client.listUsers() });
    if (resource === "sources") return jsonOk({ items: await client.listSources() });
    return jsonError("Unknown resource", 404);
  } catch (error) {
    if (error instanceof IntegrationAuthError) return jsonError("invalid_webhook", 409, { code: "invalid_webhook" });
    return jsonError(error instanceof Error ? error.message : "Failed", 502);
  }
}
