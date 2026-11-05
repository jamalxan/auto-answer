import { NextRequest, NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import {
  DM_FILE_MAX_BODY_BYTES,
  DmFileError,
  deleteDmFile,
  isWorkspaceDmFileKey,
  storeDmFile,
} from "@/lib/campaigns/dm-file";

export const dynamic = "force-dynamic";

/** Owners and admins only; returns the workspace id, or the error response. */
async function managerWorkspace(): Promise<string | NextResponse> {
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
  return context.workspaceId;
}

/** Uploads the file a campaign or an auto-reply rule sends along with its message. */
export async function POST(request: NextRequest) {
  const workspaceId = await managerWorkspace();
  if (typeof workspaceId !== "string") return workspaceId;

  // formData() holds the whole body in memory and nginx lets up to 1.1 GB
  // through (video uploads), so an oversized body is refused before it is read.
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) {
    return NextResponse.json({ success: false, error: "Fayl hajmi noma'lum" }, { status: 411 });
  }
  if (declared > DM_FILE_MAX_BODY_BYTES) {
    return NextResponse.json({ success: false, error: "Fayl 25 MB dan katta" }, { status: 413 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: "Fayl topilmadi" }, { status: 400 });
  }

  try {
    const stored = await storeDmFile(workspaceId, file);
    return NextResponse.json({ success: true, data: stored }, { status: 201 });
  } catch (error) {
    if (error instanceof DmFileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error("[Automations] DM file upload failed:", error);
    return NextResponse.json({ success: false, error: "Faylni saqlab bo'lmadi" }, { status: 500 });
  }
}

/**
 * Drops an uploaded file the form no longer wants (removed, replaced or the
 * form closed before saving). A file a saved campaign or rule still uses is
 * kept — deleteDmFile checks — so the browser may call this freely.
 */
export async function DELETE(request: NextRequest) {
  const workspaceId = await managerWorkspace();
  if (typeof workspaceId !== "string") return workspaceId;

  const key = request.nextUrl.searchParams.get("key") ?? "";
  if (!isWorkspaceDmFileKey(workspaceId, key)) {
    return NextResponse.json({ success: false, error: "Invalid file" }, { status: 400 });
  }
  await deleteDmFile(key);
  return NextResponse.json({ success: true });
}
