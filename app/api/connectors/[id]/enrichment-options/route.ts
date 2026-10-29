import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { enrichmentOptions } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Live lookup of the CRM custom fields and statuses for the enrichment form. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await enrichmentOptions(auth.ctx.workspaceId, id));
}
