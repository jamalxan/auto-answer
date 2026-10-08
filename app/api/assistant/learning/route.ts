import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { learnForProfile } from "@/lib/assistant/learning";
import { findProfile } from "@/lib/assistant/profile";

export const dynamic = "force-dynamic";
// Reads up to 50 Instagram threads, then one long LLM call.
export const maxDuration = 120;

const bodySchema = z.object({
  instagramAccountId: z.string().nullable().optional(),
});

/** "Learn now": re-read the managers' conversations and refresh the learned style. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const profile = await findProfile(auth.ctx.workspaceId, parsed.data.instagramAccountId ?? null);
  if (!profile) return jsonError("Profile not found", 404, { code: "no_profile" });

  try {
    const outcome = await learnForProfile(profile.id);
    if (outcome.status === "no_llm") return jsonError("no_llm", 503, { code: "no_llm" });
    return jsonOk(outcome);
  } catch (error) {
    console.error("[Assistant learning] failed:", error instanceof Error ? error.message : error);
    return jsonError("learning_failed", 500, { code: "learning_failed" });
  }
}
