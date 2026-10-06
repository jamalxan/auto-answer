import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

const ONBOARDING_CODE_TTL_MS = 30 * 60_000;

/** One-time `onb_<code>` deep link (30 min) tied to workspace, user and Instagram account. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  if (!isTelegramConfigured() || !getBotUsername()) {
    return jsonError("Telegram bot is not configured", 503, { code: "bot_not_configured" });
  }

  const body = z
    .object({ instagramAccountId: z.string().nullable().optional() })
    .safeParse(await request.json().catch(() => ({})));
  if (!body.success) return jsonError("Invalid request", 400);

  const igAccountId = body.data.instagramAccountId ?? null;
  if (igAccountId) {
    const owns = await prisma.instagramAccount.findFirst({
      where: { id: igAccountId, workspaceId: auth.ctx.workspaceId },
      select: { id: true },
    });
    if (!owns) return jsonError("Instagram account not found", 404);
  }

  const code = `onb_${randomBytes(12).toString("base64url")}`;
  await prisma.telegramLinkCode.create({
    data: {
      code,
      workspaceId: auth.ctx.workspaceId,
      purpose: "onboarding",
      userId: auth.ctx.userId,
      igAccountId,
      expiresAt: new Date(Date.now() + ONBOARDING_CODE_TTL_MS),
    },
  });
  return jsonOk({ url: `https://t.me/${getBotUsername()}?start=${code}`, expiresInMinutes: 30 });
}
