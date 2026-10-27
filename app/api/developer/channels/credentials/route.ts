import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { capabilityMatrix } from "@/lib/channels/capabilities";
import { listCredentials, revokeCredential } from "@/lib/channels/vault";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** The workspace's channel credentials (never a secret) + the capability matrix. */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk({ credentials: await listCredentials(auth.ctx.workspaceId), capabilities: capabilityMatrix() });
}

/** { action: "revoke", id } — only this workspace's rows. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown } | null;
  if (body?.action !== "revoke" || typeof body.id !== "string") return jsonError("action: revoke, id kerak", 400);
  return (await revokeCredential(auth.ctx.workspaceId, body.id)) ? jsonOk({ ok: true }) : jsonError("Topilmadi", 404);
}
