import { NextRequest } from "next/server";
import { requireMcp, respondMcp } from "@/lib/developer/mcp-guard";
import { rejectActionAsDeveloper } from "@/lib/mcp/confirm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** A person rejects a PROPOSED action; it can never run afterwards. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireMcp("revoke");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respondMcp(() => rejectActionAsDeveloper(auth.ctx.workspaceId, id));
}
