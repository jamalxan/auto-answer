import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate, type TgUpdate } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Telegram bot webhook. Authenticated twice: the secret in the URL path and
 * the `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes back (both are
 * TELEGRAM_WEBHOOK_SECRET, registered with scripts/set-telegram-webhook.mjs).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ secret: string }> }
) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const { secret } = await context.params;
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";

  if (!expected || !safeEqual(secret, expected) || !safeEqual(header, expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // Always 200 once authenticated: a failed handler must not make Telegram
  // retry the same update forever (handleTelegramUpdate logs its own errors).
  await handleTelegramUpdate(update);
  return NextResponse.json({ ok: true });
}
