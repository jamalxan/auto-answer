import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { getItem, mappingPatchSchema, patchItem, run } from "@/lib/migration/service";
import { BODY_LIMITS, NOT_JSON, parseBody, readJsonObjectLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; itemId: string }> };

/** One item with its full pasted text (the project read only carries a preview). */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireMigration("read");
  if (!auth.ok) return auth.response;
  const { id, itemId } = await params;
  return respondSafe(await run(() => getItem(auth.ctx.workspaceId, id, itemId)));
}

/** Edits the mapping of one item and/or marks it (PENDING / MAPPED / SKIPPED). */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireMigration("write");
  if (!auth.ok) return auth.response;
  const { id, itemId } = await params;
  const { body, response } = await readJsonObjectLimited(request, BODY_LIMITS.small);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);
  const parsed = parseBody(mappingPatchSchema, body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  return respondSafe(await run(() => patchItem(auth.ctx.workspaceId, id, itemId, parsed.data)));
}
