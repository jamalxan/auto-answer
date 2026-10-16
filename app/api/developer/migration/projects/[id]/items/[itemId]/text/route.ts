import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { MAX_FLOW_TEXT, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS } from "@/lib/migration/config";
import { flowTextSchema, run, submitFlowText } from "@/lib/migration/service";
import { NOT_JSON, parseBody, readJsonObjectLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; itemId: string }> };

/** Decoded size of a base64 / data-URL string (no allocation). */
function base64Bytes(value: string): number {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const raw = comma >= 0 ? value.slice(comma + 1) : value;
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
}

function imageSize(image: unknown): number {
  if (typeof image === "string") return base64Bytes(image);
  if (image && typeof image === "object") {
    const data = (image as { data?: unknown; base64?: unknown }).data ?? (image as { base64?: unknown }).base64;
    if (typeof data === "string") return base64Bytes(data);
  }
  return 0;
}

/**
 * Saves the pasted text and/or reads screenshots into text. Images are only
 * ever processed in memory; the item keeps the extracted text, never the image.
 */
export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireMigration("write");
  if (!auth.ok) return auth.response;
  const limit = Math.ceil(MAX_SCREENSHOTS * MAX_SCREENSHOT_BYTES * 1.4) + MAX_FLOW_TEXT * 4 + 64 * 1024;
  const { id, itemId } = await params;
  const { body, response } = await readJsonObjectLimited(request, limit);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);

  const images = (body as { images?: unknown }).images;
  if (images !== undefined) {
    if (!Array.isArray(images)) return jsonError("images: ro'yxat bo'lishi kerak", 400);
    if (images.length > MAX_SCREENSHOTS) {
      return jsonError(`Ko'pi bilan ${MAX_SCREENSHOTS} ta rasm yuklash mumkin. Yechim: eng muhim ekranlarni qoldiring yoki matnni qo'lda joylang.`, 422);
    }
    if (images.some((image) => imageSize(image) > MAX_SCREENSHOT_BYTES)) {
      const mb = Math.round((MAX_SCREENSHOT_BYTES / (1024 * 1024)) * 10) / 10;
      return jsonError(`Rasm juda katta (har biri ${mb} MB gacha). Yechim: ekran rasmini kichraytiring yoki qirqib oling.`, 413);
    }
  }
  const text = (body as { text?: unknown }).text;
  if (typeof text === "string" && text.length > MAX_FLOW_TEXT) {
    return jsonError(`Matn ${MAX_FLOW_TEXT} belgidan oshmasin. Yechim: flow'ni qismlarga bo'lib kiriting.`, 422);
  }

  const parsed = parseBody(flowTextSchema, body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  return respondSafe(await run(() => submitFlowText(auth.ctx.workspaceId, id, itemId, parsed.data)));
}
