/**
 * Reads a request's JSON body under a hard byte cap that does not trust
 * Content-Length: the stream is counted chunk by chunk and cancelled as soon
 * as `maxBytes` is crossed, so a spoofed header or a chunked upload never
 * reaches JSON.parse unbounded. Shared by the migration (ETAP 11) and MCP
 * (ETAP 12) routes, which add their own status texts.
 *
 * `value` is the parsed JSON, `undefined` for an empty body and `null` for
 * malformed JSON.
 */

export type LimitedBody = { ok: true; value: unknown } | { ok: false; tooLarge: true };

export function declaredTooLarge(headers: Headers, maxBytes: number): boolean {
  const length = Number(headers.get("content-length") ?? "0");
  return Number.isFinite(length) && length > maxBytes;
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<LimitedBody> {
  if (declaredTooLarge(request.headers, maxBytes)) return { ok: false, tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: undefined };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: true, value: null };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: true, value: null };
  }
}
