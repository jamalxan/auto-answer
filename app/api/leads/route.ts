import { NextRequest } from "next/server";
import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { buildLeadWhere } from "@/lib/leads/query";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const sp = request.nextUrl.searchParams;

  const where = buildLeadWhere(auth.ctx.workspaceId, {
    status: sp.get("status"),
    source: sp.get("source"),
    account: sp.get("account"),
    from: sp.get("from"),
    to: sp.get("to"),
    q: sp.get("q"),
  });
  const page = Math.max(1, Number(sp.get("page")) || 1);

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        name: true,
        phoneE164: true,
        igUsername: true,
        productInterest: true,
        source: true,
        campaignName: true,
        status: true,
        flag: true,
        isTest: true,
        isRepeat: true,
        contactedAt: true,
        conversationId: true,
        instagramAccount: { select: { username: true } },
        deliveries: {
          select: { id: true, status: true, kind: true, integration: { select: { type: true, name: true } } },
        },
      },
    }),
  ]);

  return jsonOk({
    leads: leads.map((l) => ({
      ...l,
      accountUsername: l.instagramAccount.username,
      instagramAccount: undefined,
      deliveries: l.deliveries
        .filter((d) => d.kind === "new" || l.isRepeat)
        .map((d) => ({ id: d.id, status: d.status, type: d.integration.type, name: d.integration.name })),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    canManage: auth.ctx.role !== "MEMBER",
  });
}
