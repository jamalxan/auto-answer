import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { requestBackfill } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/**
 * One-off import of the four stores into CrmContact for this workspace
 * (design, phase 5.0). Queued on the "crm" worker (202): the import runs
 * silently in pages of 500, outside the HTTP request. 409 while the CRM is off.
 */
export async function POST() {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  return respond(await requestBackfill(auth.ctx.workspaceId, auth.ctx.userId), 202);
}
