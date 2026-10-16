import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { approveVersion, run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; vid: string }> };

export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { vid } = await params;
  return respond(await run(() => approveVersion(auth.ctx.workspaceId, vid, auth.ctx.userId)));
}
