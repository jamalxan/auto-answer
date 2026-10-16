import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { convertFlow, run } from "@/lib/migration/service";
import { BODY_LIMITS, NOT_JSON, readJsonLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Props = { params: Promise<{ id: string; itemId: string }> };

/** AI conversion of the stored flow text to a graph: returns { graph, warnings, audit, policy }; no flow is created. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireMigration("convert");
  if (!auth.ok) return auth.response;
  const { id, itemId } = await params;
  // Optional body (target account / trigger type); a malformed one is a 400.
  const read = await readJsonLimited(request, BODY_LIMITS.small);
  if (!read.ok) return read.response;
  if (read.value === null) return jsonError(NOT_JSON, 400);
  const body: unknown = read.value ?? {};
  return respondSafe(await run(() => convertFlow(auth.ctx.workspaceId, id, itemId, body)));
}
