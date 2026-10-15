import { createHmac, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";

/**
 * Developer area (/developer) — its own login, separate from both the
 * customer NextAuth session and the platform admin panel.
 *
 * Exactly one developer: DEVELOPER_EMAIL plus DEVELOPER_PASSWORD_HASH
 * (scrypt "salt:hash" in hex; `node scripts/hash-developer-password.mjs`
 * prints one). The password itself never lives in the repo. With either
 * variable unset the area stays closed.
 *
 * The session is an HMAC-signed cookie bound to the configured email, so
 * changing DEVELOPER_EMAIL (or NEXTAUTH_SECRET) logs every session out.
 */

export const DEVELOPER_SESSION_COOKIE = "socialauto_dev_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

function configuredEmail(): string | null {
  const email = process.env.DEVELOPER_EMAIL?.trim().toLowerCase();
  return email || null;
}

export function isDeveloperAreaConfigured(): boolean {
  return Boolean(configuredEmail() && process.env.DEVELOPER_PASSWORD_HASH);
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return safeEqual(actual, expected);
}

export function verifyDeveloperCredentials(email: string, password: string): boolean {
  const expectedEmail = configuredEmail();
  const storedHash = process.env.DEVELOPER_PASSWORD_HASH;
  if (!expectedEmail || !storedHash) return false;

  // Always run scrypt so a wrong email costs as long as a wrong password.
  const passwordOk = verifyPassword(password, storedHash);
  const emailOk = safeEqual(
    Buffer.from(email.trim().toLowerCase()),
    Buffer.from(expectedEmail)
  );
  return emailOk && passwordOk;
}

// ─── Session cookie ──────────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(`developer:${payload}`)
    .digest("base64url");
}

function buildToken(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Exported for tests; pages and routes use getDeveloperSession(). */
export function readDeveloperToken(token: string): { email: string } | null {
  if (!isDeveloperAreaConfigured()) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null;

  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof email !== "string" || typeof exp !== "number") return null;
    if (Date.now() > exp) return null;
    if (email !== configuredEmail()) return null;
    return { email };
  } catch {
    return null;
  }
}

export function createDeveloperToken(): string | null {
  const email = configuredEmail();
  return email && isDeveloperAreaConfigured() ? buildToken(email) : null;
}

export async function setDeveloperSessionCookie(): Promise<void> {
  const token = createDeveloperToken();
  if (!token) return;
  const store = await cookies();
  store.set(DEVELOPER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearDeveloperSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete({ name: DEVELOPER_SESSION_COOKIE, path: "/" });
}

export async function getDeveloperSession(): Promise<{ email: string } | null> {
  const store = await cookies();
  const token = store.get(DEVELOPER_SESSION_COOKIE)?.value;
  return token ? readDeveloperToken(token) : null;
}
