import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireEngagement } from "@/lib/developer/engagement-guard";
import { listRecentMedia } from "@/lib/triggers/comment-service";

export const dynamic = "force-dynamic";

/** Recent posts of one account for the giveaway post picker (same lister as Comment 2.0). */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return jsonError("accountId kerak", 400);
  const media = await listRecentMedia(auth.ctx.workspaceId, accountId);
  if (!media) return jsonError("Instagram akkaunt topilmadi", 404);
  return jsonOk(media);
}
