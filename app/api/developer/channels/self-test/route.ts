import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { usableCredentials } from "@/lib/channels/access";
import { draftSelfTest } from "@/lib/channels/facebook";
import { ChannelError } from "@/lib/channels/types";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** { id } — Facebook Page only: creates an unpublished post and deletes it again (nothing becomes public). */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (!body || typeof body.id !== "string") return jsonError("id kerak", 400);
  try {
    const creds = await usableCredentials(auth.ctx.workspaceId, body.id);
    if (creds.channel !== "facebook") return jsonError("Sinov faqat Facebook sahifa uchun", 400);
    return jsonOk(await draftSelfTest(creds));
  } catch (error) {
    if (error instanceof ChannelError) return jsonError(error.message, 502);
    throw error;
  }
}
