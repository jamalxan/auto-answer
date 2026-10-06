import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { parseProductsSmart } from "@/lib/assistant/products-parse";
import { getLlmProvider } from "@/lib/assistant/llm/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Turn pasted "name — price" lines (or free text) into rows. The editor shows them before saving. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const body = z.object({ text: z.string().min(1).max(20_000) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError("Invalid request", 400);

  const products = await parseProductsSmart(body.data.text, getLlmProvider());
  return jsonOk({
    products: products.map((p) => ({
      name: p.name,
      price: p.price,
      priceIsFrom: p.priceIsFrom,
      currency: p.currency,
      note: p.note,
      unit: p.unit,
      priceUnclear: p.priceUnclear,
    })),
  });
}
