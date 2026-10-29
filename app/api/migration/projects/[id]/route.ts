import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireMigration, respondSafe } from "@/lib/developer/migration-guard";
import { deleteProject, getProject, run } from "@/lib/migration/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireMigration("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respondSafe(await run(() => getProject(auth.ctx.workspaceId, id)));
}

/** Deletes the project, its items and the stored (encrypted) ManyChat key. Flows already imported stay. */
export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireMigration("delete");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(() => deleteProject(auth.ctx.workspaceId, id));
  if (!result.ok) return respondSafe(result);
  return jsonOk({ deleted: true });
}
