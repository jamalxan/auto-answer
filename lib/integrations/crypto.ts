import { decryptToken, encryptToken } from "@/lib/meta/oauth";

/**
 * Integration credentials are stored as an encrypted JSON string, using the
 * exact same AES-GCM mechanism as Instagram access tokens.
 */
export function encryptCredentials(value: Record<string, unknown>): string {
  return encryptToken(JSON.stringify(value));
}

export function decryptCredentials<T extends Record<string, unknown>>(
  encrypted: string | null | undefined
): T {
  if (!encrypted) return {} as T;
  return JSON.parse(decryptToken(encrypted)) as T;
}

/** UI never shows a secret in full — only its last four characters. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const tail = value.slice(-4);
  return `••••${tail}`;
}

/** +998901234567 -> +99890***4567 (TZ section 12: phones are masked in logs). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  if (phone.length <= 8) return "***";
  return `${phone.slice(0, 6)}***${phone.slice(-4)}`;
}
