import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { getDelivery } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** The frozen payload (full phone numbers) is returned to manage roles only. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const payloadAuth = await requireIntegrations("payload");
  return respond(await getDelivery(auth.ctx.workspaceId, id, payloadAuth.ok));
}
