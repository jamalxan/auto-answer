import { jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { loadErrorFeed } from "@/lib/foundation/errors-feed";

export const dynamic = "force-dynamic";

// Last 7 days of this workspace's failures, each as Muammo / Sabab / Yechim.
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  return jsonOk({ errors: await loadErrorFeed(auth.ctx.workspaceId) });
}
