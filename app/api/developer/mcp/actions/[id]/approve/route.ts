import { NextRequest } from "next/server";
import { requireMcp, respondMcp } from "@/lib/developer/mcp-guard";
import { approveActionAsDeveloper } from "@/lib/mcp/confirm";
import { executeStored } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** A person approves a PROPOSED action: same atomic claim as confirm_action, runs the stored input, records approvedBy. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireMcp("approve");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respondMcp(() => approveActionAsDeveloper(auth.ctx.workspaceId, id, auth.ctx.userId, executeStored));
}
