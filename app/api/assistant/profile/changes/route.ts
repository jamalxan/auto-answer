import { NextRequest } from "next/server";
import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const accountId = request.nextUrl.searchParams.get("instagramAccountId") || null;
  const changes = await prisma.profileChangeLog.findMany({
    where: { profile: { workspaceId: auth.ctx.workspaceId, instagramAccountId: accountId } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return jsonOk({ changes });
}
