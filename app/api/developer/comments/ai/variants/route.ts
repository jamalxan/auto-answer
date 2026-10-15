import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import {
  AI_ERROR_STATUS,
  aiVariantRequestSchema,
  AiVariantsError,
  generateVariantDrafts,
} from "@/lib/triggers/ai-variants";
import { firstIssue } from "@/lib/triggers/comment-service";

export const dynamic = "force-dynamic";

/** Generate reply drafts for review. Saves nothing — approval happens in the builder. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = aiVariantRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  try {
    return jsonOk(await generateVariantDrafts(parsed.data));
  } catch (error) {
    if (error instanceof AiVariantsError) {
      return jsonError(error.message, AI_ERROR_STATUS[error.code], { code: error.code });
    }
    throw error;
  }
}
