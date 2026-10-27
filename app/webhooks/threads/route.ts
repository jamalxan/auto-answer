import type { NextRequest } from "next/server";
import { normalizeThreadsWebhook } from "@/lib/channels/threads";
import { handleChannelWebhook, verifySubscription } from "@/lib/webhooks/channel-webhook";

export const dynamic = "force-dynamic";

/** Threads webhooks (replies, mentions), signed with THREADS_APP_SECRET. */
export async function GET(request: NextRequest) {
  return verifySubscription(request);
}

export async function POST(request: NextRequest) {
  return handleChannelWebhook(request, "threads", process.env.THREADS_APP_SECRET?.trim(), normalizeThreadsWebhook);
}
