/**
 * The developer login accepts an optional `next` (the OAuth consent screen sends
 * people there and back). Only a relative /developer/... path is honoured: no
 * scheme, no protocol-relative //host, no backslashes or line breaks.
 */
export function safeDeveloperNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  if (!value.startsWith("/developer/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return null;
  return value;
}
