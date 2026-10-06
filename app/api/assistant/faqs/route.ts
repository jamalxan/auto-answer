import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { findProfile } from "@/lib/assistant/profile";
import { ensureProfile } from "@/lib/assistant/profile-write";

export const dynamic = "force-dynamic";

const body = z.object({
  instagramAccountId: z.string().nullable().optional(),
  question: z.string().min(1).max(200),
  answer: z.string().min(1).max(400),
});

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const profile = await findProfile(
    auth.ctx.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId") || null
  );
  return jsonOk({ faqs: profile?.faqs ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const profile = await ensureProfile(auth.ctx.workspaceId, parsed.data.instagramAccountId ?? null);
  const count = await prisma.assistantFaq.count({ where: { profileId: profile.id } });
  // Owner-written FAQs are capped at 5; answered knowledge gaps may exceed it.
  const owned = await prisma.assistantFaq.count({ where: { profileId: profile.id, source: "OWNER" } });
  if (owned >= 5) return jsonError("At most 5 FAQs", 422, { code: "too_many_faqs" });

  const faq = await prisma.assistantFaq.create({
    data: {
      profileId: profile.id,
      question: parsed.data.question,
      answer: parsed.data.answer,
      sort: count,
    },
  });
  return jsonOk({ faq }, 201);
}
