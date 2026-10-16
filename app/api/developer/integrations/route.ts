import { jsonOk } from "@/lib/api-auth";
import { requireIntegrations } from "@/lib/developer/integrations-guard";
import { listIntegrations } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** Every Integration row of the workspace (legacy Telegram / amoCRM / Bitrix24 included), secrets masked. */
export async function GET() {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  return jsonOk(await listIntegrations(auth.ctx.workspaceId));
}
