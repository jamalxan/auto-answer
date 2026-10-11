import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { requireTriggerDev } from "@/lib/triggers/access";
import { simulateStoryReply } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  instagramAccountId: z.string().min(1),
  text: z.string().max(2000),
  storyId: z.string().trim().max(64).optional().nullable(),
});

/** Dry run of the matching step — sends nothing, stores nothing. */
export async function POST(request: NextRequest) {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Akkaunt va matn kerak", 400);

  const account = await prisma.instagramAccount.findFirst({
    where: { id: parsed.data.instagramAccountId, workspaceId: auth.ctx.workspaceId },
    select: { id: true },
  });
  if (!account) return jsonError("Instagram akkaunt topilmadi", 404);

  return jsonOk(await simulateStoryReply(auth.ctx.workspaceId, parsed.data));
}
