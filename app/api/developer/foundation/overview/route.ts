import { jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { loadFoundationOverview } from "@/lib/foundation/overview";

export const dynamic = "force-dynamic";

// Connections (derived status) + queue + diagnostics for the signed-in
// workspace. Every query inside is scoped by auth.ctx.workspaceId.
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  return jsonOk(await loadFoundationOverview(auth.ctx.workspaceId));
}
