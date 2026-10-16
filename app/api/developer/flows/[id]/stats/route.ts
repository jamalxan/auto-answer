import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { run } from "@/lib/flows/service";
import { flowStats } from "@/lib/flows/runs";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => flowStats(auth.ctx.workspaceId, id)));
}
