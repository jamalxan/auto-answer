import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { requireTriggerDev } from "@/lib/triggers/access";
import { recentRepliedStories } from "@/lib/triggers/service";
import { fetchActiveStories } from "@/lib/triggers/stories";

export const dynamic = "force-dynamic";

/** Live stories from Instagram plus stories people already replied to. */
export async function GET(request: NextRequest) {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;

  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return jsonError("accountId kerak", 400);

  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId: auth.ctx.workspaceId },
    select: { id: true, instagramId: true, accessToken: true },
  });
  if (!account) return jsonError("Instagram akkaunt topilmadi", 404);

  const [live, replied] = await Promise.all([
    fetchActiveStories(account.accessToken, account.instagramId),
    recentRepliedStories(auth.ctx.workspaceId, account.id),
  ]);
  return jsonOk({ live: live.stories, liveError: live.error, replied });
}
