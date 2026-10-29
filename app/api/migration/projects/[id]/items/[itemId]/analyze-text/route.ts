import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { analyzeFlowText } from "@/lib/migration/analyzer";
import { MAX_FLOW_TEXT } from "@/lib/migration/config";
import { BODY_LIMITS, NOT_JSON, parseBody, readJsonObjectLimited, requireMigration } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ text: z.string().max(MAX_FLOW_TEXT, `Matn ${MAX_FLOW_TEXT} belgidan oshmasin`) });

/**
 * Pure preview of the ManyChat features detected in the text. Nothing is
 * stored and the database is not touched (the ids in the path only keep the
 * URL uniform with the other item routes).
 */
export async function POST(request: NextRequest) {
  const auth = await requireMigration("preview");
  if (!auth.ok) return auth.response;
  const { body, response } = await readJsonObjectLimited(request, BODY_LIMITS.small);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);
  const parsed = parseBody(bodySchema, body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  return jsonOk(analyzeFlowText(parsed.data.text));
}
