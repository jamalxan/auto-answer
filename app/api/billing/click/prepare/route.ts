import { NextResponse, type NextRequest } from "next/server";
import { handleClick } from "@/lib/billing/click";
import { clickEnabled } from "@/lib/billing/payments";

export const dynamic = "force-dynamic";

/** Click Shop API Prepare (action=0; form body, signed). Off (404) until CLICK_ENABLED and keys are set. */
export async function POST(request: NextRequest) {
  if (!clickEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const params: Record<string, string> = {};
  form?.forEach((value, key) => {
    if (typeof value === "string") params[key] = value;
  });
  return NextResponse.json(await handleClick(params));
}
