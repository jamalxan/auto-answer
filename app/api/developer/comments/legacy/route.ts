import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { LegacyMigrationError, listLegacyMigrations, startLegacyShadow } from "@/lib/campaigns/legacy-migration";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** Old (production) campaigns with their migration plan and shadow comparison. */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk({ items: await listLegacyMigrations(auth.ctx.workspaceId) });
}

/** { automationId } → create the switched-off copy and start the comparison. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { automationId?: unknown } | null;
  if (typeof body?.automationId !== "string" || !body.automationId) return jsonError("automationId kerak", 400);
  try {
    return jsonOk(await startLegacyShadow(auth.ctx.workspaceId, body.automationId), 201);
  } catch (error) {
    if (error instanceof LegacyMigrationError) return jsonError(error.message, error.status);
    throw error;
  }
}
