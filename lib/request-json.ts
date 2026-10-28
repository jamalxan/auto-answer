/** fetch helpers for client components: unwrap the `{ success, data | error }` envelope of our API. */

export type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** fetch + `{ success, data | error }` unwrap. Never throws. */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      return { ok: false, status: res.status, error: body?.error ?? `So'rov bajarilmadi (${res.status})` };
    }
    return { ok: true, data: body.data as T };
  } catch {
    return { ok: false, status: 0, error: "Server bilan aloqa yo'q — internetni tekshirib, qayta urinib ko'ring" };
  }
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
