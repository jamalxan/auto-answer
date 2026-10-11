import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireTriggerDev } from "@/lib/triggers/access";
import { getEventDetail } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const detail = await getEventDetail(auth.ctx.workspaceId, id);
  if (!detail) return jsonError("Not found", 404);
  return jsonOk(detail);
}
