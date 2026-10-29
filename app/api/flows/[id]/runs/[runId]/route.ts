import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { run } from "@/lib/flows/service";
import { getRun } from "@/lib/flows/runs";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; runId: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  return respond(await run(() => getRun(auth.ctx.workspaceId, runId)));
}
