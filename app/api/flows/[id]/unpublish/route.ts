import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { run, unpublish } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { to?: unknown } | null;
  const to = body?.to === "ARCHIVED" ? "ARCHIVED" : "DRAFT";
  return respond(await run(() => unpublish(auth.ctx.workspaceId, id, to)));
}
