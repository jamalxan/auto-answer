import { NextResponse, type NextRequest } from "next/server";
import { handlePayme } from "@/lib/billing/payme";
import { paymeEnabled } from "@/lib/billing/payments";
import { readLimitedBody } from "@/lib/webhooks/gateway";

export const dynamic = "force-dynamic";

/** Payme Merchant API endpoint (JSON-RPC). Off (404) until PAYME_ENABLED and keys are set. */
export async function POST(request: NextRequest) {
  if (!paymeEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const read = await readLimitedBody(request, 64_000);
  if (!read.ok) return NextResponse.json({ error: "Bad body" }, { status: read.status });
  return NextResponse.json(await handlePayme(read.body, request.headers.get("authorization")));
}
