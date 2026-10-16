import { NextRequest } from "next/server";
import { requireMcp, respondMcp } from "@/lib/developer/mcp-guard";
import { revokeToken } from "@/lib/mcp/tokens";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Revokes the token (it stops working at once) and withdraws its unconfirmed proposals. */
export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireMcp("revoke");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respondMcp(async () => {
    await revokeToken(auth.ctx.workspaceId, id);
    return { revoked: true };
  });
}
