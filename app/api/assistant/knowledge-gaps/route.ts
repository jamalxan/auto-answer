import { NextRequest } from "next/server";
import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const status = request.nextUrl.searchParams.get("status");
  const statusFilter =
    status === "open"
      ? { status: "OPEN" as const }
      : status === "answered"
        ? { status: "ANSWERED" as const }
        : status === "ignored"
          ? { status: "IGNORED" as const }
          : {};

  const gaps = await prisma.knowledgeGap.findMany({
    where: { workspaceId: auth.ctx.workspaceId, ...statusFilter },
    orderBy: [{ hits: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  return jsonOk({
    gaps: gaps.map((g) => ({
      id: g.id,
      question: (Array.isArray(g.examples) && (g.examples as string[])[0]) || g.questionNormalized,
      hits: g.hits,
      status: g.status,
      answer: g.answer,
      createdAt: g.createdAt,
    })),
  });
}
