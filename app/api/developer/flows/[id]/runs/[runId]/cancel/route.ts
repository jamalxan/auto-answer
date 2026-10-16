import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { run } from "@/lib/flows/service";
import { cancelRun } from "@/lib/flows/runs";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; runId: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  return respond(await run(() => cancelRun(auth.ctx.workspaceId, runId)));
}
