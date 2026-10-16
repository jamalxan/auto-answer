import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { checkConnection } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Connection check; a repaired BROKEN integration releases its held deliveries. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await checkConnection(auth.ctx.workspaceId, id));
}
