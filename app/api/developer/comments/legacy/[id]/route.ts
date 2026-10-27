import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { cutoverLegacyMigration, LegacyMigrationError, rollbackLegacyMigration } from "@/lib/campaigns/legacy-migration";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** { action: "cutover", force?, reason? } | { action: "rollback" } on one migration. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { action?: unknown; force?: unknown; reason?: unknown } | null;
  try {
    if (body?.action === "cutover") {
      await cutoverLegacyMigration(auth.ctx.workspaceId, id, { force: body.force === true, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined });
    } else if (body?.action === "rollback") {
      await rollbackLegacyMigration(auth.ctx.workspaceId, id);
    } else {
      return jsonError("action: cutover yoki rollback", 400);
    }
    return jsonOk({ ok: true });
  } catch (error) {
    if (error instanceof LegacyMigrationError) return jsonError(error.message, error.status);
    throw error;
  }
}
