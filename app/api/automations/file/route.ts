import { NextRequest, NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { DmFileError, storeDmFile } from "@/lib/campaigns/dm-file";

export const dynamic = "force-dynamic";

/** Uploads the file a comment-to-DM campaign sends along with its DM. */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update campaigns" },
      { status: 403 }
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: "Fayl topilmadi" }, { status: 400 });
  }

  try {
    const stored = await storeDmFile(context.workspaceId, file);
    return NextResponse.json({ success: true, data: stored }, { status: 201 });
  } catch (error) {
    if (error instanceof DmFileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error("[Automations] DM file upload failed:", error);
    return NextResponse.json({ success: false, error: "Faylni saqlab bo'lmadi" }, { status: 500 });
  }
}
