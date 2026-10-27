import type { NextRequest } from "next/server";
import { normalizeFacebookWebhook } from "@/lib/channels/facebook";
import { handleChannelWebhook, verifySubscription } from "@/lib/webhooks/channel-webhook";

export const dynamic = "force-dynamic";

/** Facebook Page webhooks (feed comments, Messenger), signed with FACEBOOK_APP_SECRET. */
export async function GET(request: NextRequest) {
  return verifySubscription(request);
}

export async function POST(request: NextRequest) {
  return handleChannelWebhook(request, "facebook", process.env.FACEBOOK_APP_SECRET?.trim(), normalizeFacebookWebhook);
}
