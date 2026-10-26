import { NextRequest } from "next/server";
import { completeUpload } from "@/lib/content/media";
import { run } from "@/lib/content/service";
import { requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** Step 2 of an upload: verify the object is there and queue processing. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(
    await run(async () => {
      const asset = await completeUpload(auth.ctx.workspaceId, id);
      return { id: asset.id, status: asset.status };
    })
  );
}
