import { NextRequest } from "next/server";
import { requireMigration, respondSafe } from "@/lib/developer/migration-guard";
import { analyzeProject, run } from "@/lib/migration/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Reads tags, fields, bot fields and the flow / growth-tool lists from ManyChat (read-only calls). */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireMigration("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respondSafe(await run(() => analyzeProject(auth.ctx.workspaceId, id)));
}
