import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { listContacts } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;

  const page = Number(request.nextUrl.searchParams.get("page") ?? 1) || 1;
  return jsonOk(await listContacts(auth.ctx.workspaceId, page));
}
