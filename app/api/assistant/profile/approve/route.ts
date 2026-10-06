import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { findProfile } from "@/lib/assistant/profile";
import { approveProfile, updateProfileFields } from "@/lib/assistant/profile-write";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  instagramAccountId: z.string().nullable().optional(),
  // false = approve the content but leave the assistant switched off.
  enable: z.boolean().optional(),
});

/** An unapproved profile never goes live (TZ 3.1). */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const profile = await findProfile(auth.ctx.workspaceId, parsed.data.instagramAccountId ?? null);
  if (!profile) return jsonError("Profile not found", 404);

  try {
    await approveProfile(profile.id, "PANEL", auth.ctx.userId, parsed.data.enable ?? true);
  } catch (error) {
    if (error instanceof Error && error.message === "profile_incomplete") {
      return jsonError("Profile is incomplete", 422, { code: "profile_incomplete" });
    }
    throw error;
  }
  return jsonOk({ approved: true });
}

/** Switch a (previously approved) assistant on or off. */
export async function PATCH(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const body = z
    .object({ instagramAccountId: z.string().nullable().optional(), enabled: z.boolean() })
    .safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError("Invalid request", 400);

  const profile = await findProfile(auth.ctx.workspaceId, body.data.instagramAccountId ?? null);
  if (!profile) return jsonError("Profile not found", 404);
  if (body.data.enabled && !profile.approvedAt) {
    return jsonError("Approve the profile first", 422, { code: "not_approved" });
  }
  await updateProfileFields(profile.id, {}, "PANEL", auth.ctx.userId, { enabled: body.data.enabled });
  return jsonOk({ enabled: body.data.enabled });
}
