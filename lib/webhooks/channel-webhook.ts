/**
 * Webhooks of the vault channels (Facebook Page, Threads), through the
 * gateway (T2): body size limit, X-Hub-Signature-256 with the channel's app
 * secret, 48 h dedup by body hash, then normalise → ChannelMessage inbox.
 * A processing error forgets the dedup key and answers 500, so Meta's retry
 * goes through.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ingestChannelEvents } from "@/lib/channels/inbox";
import type { InboundEvent } from "@/lib/channels/types";
import { bodyFingerprint, forgetSeen, logRejectedWebhook, readLimitedBody, seenBefore } from "./gateway";

export function verifyHubSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Meta's subscription handshake (hub.challenge). */
export function verifySubscription(request: NextRequest): NextResponse {
  const params = request.nextUrl.searchParams;
  const expected = process.env.WEBHOOK_VERIFY_TOKEN;
  if (params.get("hub.mode") === "subscribe" && expected && params.get("hub.verify_token") === expected) {
    return new NextResponse(params.get("hub.challenge"), { status: 200 });
  }
  return NextResponse.json({ ok: false }, { status: 403 });
}

export async function handleChannelWebhook(
  request: NextRequest,
  channel: "facebook" | "threads",
  secret: string | undefined,
  normalize: (payload: unknown, rawRef: string | null) => InboundEvent[]
): Promise<NextResponse> {
  if (!secret) {
    console.error(`[Webhook] ${channel}: app secret is not configured`);
    return NextResponse.json({ ok: false, error: "Webhook verification is not configured" }, { status: 500 });
  }
  const read = await readLimitedBody(request);
  if (!read.ok) {
    await logRejectedWebhook(channel, read.status === 413 ? "body too large" : "body not utf-8");
    return NextResponse.json({ ok: false }, { status: read.status });
  }
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyHubSignature(read.body, signature, secret)) {
    await logRejectedWebhook(channel, "signature verification failed", { bodyLength: read.body.length, hadSignature: Boolean(signature) });
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const fingerprint = bodyFingerprint(read.body);
  if (await seenBefore(channel, fingerprint)) return NextResponse.json({ ok: true, duplicate: true });

  let payload: unknown;
  try {
    payload = JSON.parse(read.body);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  try {
    const created = await ingestChannelEvents(normalize(payload, null));
    return NextResponse.json({ ok: true, created });
  } catch (error) {
    await forgetSeen(channel, fingerprint);
    console.error(`[Webhook] ${channel} processing failed:`, error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
