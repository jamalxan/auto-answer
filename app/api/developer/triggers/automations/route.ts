import { jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { listAutomations } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

/** Every ETAP 3 automation (Direct, ad, link, mention, story reply, live) in one list for the triggers home. */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  const [automations, accounts] = await Promise.all([
    listAutomations(auth.ctx.workspaceId),
    listWorkspaceAccounts(auth.ctx.workspaceId),
  ]);
  return jsonOk({ automations, accounts });
}
