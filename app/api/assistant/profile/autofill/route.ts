import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { AutofillError, buildDraftProfile } from "@/lib/assistant/autofill";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { TokenExpiredError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  instagramAccountId: z.string().nullable().optional(),
  websiteUrl: z.string().max(300).nullable().optional(),
});

/** Draft only — the owner reviews, edits and approves it. Nothing is saved. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const account = await getWorkspaceInstagramAccount(auth.ctx.workspaceId, parsed.data.instagramAccountId);
  if (!account) return jsonError("Instagram account not connected", 400);

  try {
    const draft = await buildDraftProfile({
      accessToken: decryptToken(account.accessToken),
      websiteUrl: parsed.data.websiteUrl || null,
    });
    return jsonOk({ draft });
  } catch (error) {
    if (error instanceof AutofillError) {
      const status = error.code === "no_llm" ? 503 : 422;
      return jsonError(error.code, status, { code: error.code });
    }
    if (error instanceof TokenExpiredError) return jsonError("token_expired", 409, { code: "token_expired" });
    console.error("[Assistant autofill] failed:", error instanceof Error ? error.message : error);
    return jsonError("autofill_failed", 500);
  }
}
