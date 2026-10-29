import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { importFlow, run } from "@/lib/migration/service";
import { BODY_LIMITS, NOT_JSON, readJsonLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; itemId: string }> };

/** Saves the converted graph as a DRAFT flow (never published) and returns its id and a link to Flows. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireMigration("convert");
  if (!auth.ok) return auth.response;
  const { id, itemId } = await params;
  const read = await readJsonLimited(request, BODY_LIMITS.importGraph);
  if (!read.ok) return read.response;
  if (read.value === null) return jsonError(NOT_JSON, 400);
  const body: unknown = read.value ?? {};
  const result = await run(() => importFlow(auth.ctx.workspaceId, id, itemId, body, auth.ctx.userId));
  if (!result.ok) return respondSafe(result);
  const flowId = (result.data as { flowId?: string | null }).flowId;
  return respondSafe({ ok: true, data: { ...(result.data as object), link: flowId ? `/flows?flow=${flowId}` : null } }, 201);
}
