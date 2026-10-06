import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { IntegrationAuthError } from "@/lib/integrations/errors";
import { amoClientFromIntegration } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; resource: string }> };

/** Dropdown data for the amoCRM settings: pipelines (with stages), users, contact fields. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { id, resource } = await params;

  const integration = await prisma.integration.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId, type: "AMOCRM" },
  });
  if (!integration) return jsonError("Not found", 404);

  try {
    const client = amoClientFromIntegration(integration);
    if (resource === "pipelines") return jsonOk({ items: await client.listPipelines() });
    if (resource === "users") return jsonOk({ items: await client.listUsers() });
    if (resource === "contact-fields") return jsonOk({ items: await client.listContactFields() });
    return jsonError("Unknown resource", 404);
  } catch (error) {
    if (error instanceof IntegrationAuthError) return jsonError("invalid_token", 409, { code: "invalid_token" });
    return jsonError(error instanceof Error ? error.message : "Failed", 502);
  }
}
