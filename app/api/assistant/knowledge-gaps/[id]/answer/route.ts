import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { findProfile } from "@/lib/assistant/profile";
import { ensureProfile } from "@/lib/assistant/profile-write";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** The answer becomes an FAQ, so the assistant answers this question next time. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = z
    .object({ answer: z.string().min(1).max(400) })
    .safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError("Invalid request", 400);

  const gap = await prisma.knowledgeGap.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
  });
  if (!gap) return jsonError("Not found", 404);

  const profile =
    (await findProfile(auth.ctx.workspaceId, null)) ??
    (await ensureProfile(auth.ctx.workspaceId, null));
  const question =
    (Array.isArray(gap.examples) && (gap.examples as string[])[0]) || gap.questionNormalized;
  const count = await prisma.assistantFaq.count({ where: { profileId: profile.id } });
  await prisma.assistantFaq.create({
    data: {
      profileId: profile.id,
      question,
      answer: body.data.answer,
      source: "KNOWLEDGE_GAP",
      sort: count,
    },
  });
  await prisma.knowledgeGap.update({
    where: { id },
    data: { status: "ANSWERED", answer: body.data.answer, answeredAt: new Date() },
  });
  return jsonOk({ answered: true });
}
