/**
 * One-shot notice that survives an OAuth redirect without living in the URL:
 * a link like ?error=<text> would let anyone put their own wording on our page.
 * The server sets the cookie on the redirect (flash-server.ts); the page reads
 * and removes it here. Client-safe: no server imports.
 */
export const FLASH_COOKIE = "dev_flash";

export interface Flash {
  tone: "error" | "success" | "warning";
  text: string;
}

/** Read the notice once, clear the cookie. */
export function takeFlash(): Flash | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${FLASH_COOKIE}=`));
  if (!match) return null;
  document.cookie = `${FLASH_COOKIE}=; path=/developer; max-age=0`;
  try {
    const flash = JSON.parse(decodeURIComponent(match.slice(FLASH_COOKIE.length + 1))) as Flash;
    if (typeof flash.text !== "string" || !["error", "success", "warning"].includes(flash.tone)) return null;
    return { tone: flash.tone, text: flash.text.slice(0, 300) };
  } catch {
    return null;
  }
}
