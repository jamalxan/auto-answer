import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { rotateSecret } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** New secret (shown once); the old one keeps signing for 24 hours. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await rotateSecret(auth.ctx.workspaceId, id));
}
