import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { retryEvent } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const result = await retryEvent(auth.ctx.workspaceId, id);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ id, queued: true });
}
