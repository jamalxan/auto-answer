import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { importBasics, importBasicsSchema, run } from "@/lib/migration/service";
import { BODY_LIMITS, NOT_JSON, parseBody, readJsonObjectLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Creates the CRM tags, contact-field mappings and flow variables ({ tags, customFields, botFields } toggles). */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireMigration("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const { body, response } = await readJsonObjectLimited(request, BODY_LIMITS.small);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);
  const parsed = parseBody(importBasicsSchema, body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  return respondSafe(await run(() => importBasics(auth.ctx.workspaceId, id, parsed.data)));
}
