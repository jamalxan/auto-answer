import { NextRequest } from "next/server";
import { notFound } from "@/lib/content/errors";
import { accountQuota } from "@/lib/content/quota";
import { run } from "@/lib/content/service";
import { prisma } from "@/lib/db/client";
import { requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** "Bugun 3/50": Meta's real 24-hour quota plus what is already queued. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(
    await run(async () => {
      const account = await prisma.instagramAccount.findUnique({ where: { id }, select: { workspaceId: true } });
      if (!account || account.workspaceId !== auth.ctx.workspaceId) throw notFound("Instagram akkaunt topilmadi");
      return accountQuota(id);
    })
  );
}
