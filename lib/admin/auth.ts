import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";
import { requireEnv } from "@/lib/env";

// Platform-admin login is deliberately separate from the customer NextAuth
// system (see the AdminAccount model) — this file owns that entire
// lifecycle: password hashing, the signed session cookie, and the
// lazily-seeded default account.

const DEFAULT_USERNAME = "jamolxon";
const DEFAULT_PASSWORD = "jamolxon6706";
const DEFAULT_EMAIL = "jamolxonyoldashaliyev3@gmail.com";

export const ADMIN_SESSION_COOKIE = "socialauto_admin_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Passwords ──────────────────────────────────────────────────────────────
// scrypt (Node's built-in, no extra dependency) rather than bcrypt/argon2 —
// this app has exactly one admin account, so scrypt's cost profile is fine
// and it avoids adding a native-binding package just for this.

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Lazy seed ──────────────────────────────────────────────────────────────

async function ensureDefaultAdminAccount(): Promise<void> {
  const count = await prisma.adminAccount.count();
  if (count > 0) return;

  await prisma.adminAccount.create({
    data: {
      username: DEFAULT_USERNAME,
      passwordHash: hashPassword(DEFAULT_PASSWORD),
      email: DEFAULT_EMAIL,
    },
  });
}

export interface AdminAccountView {
  id: string;
  username: string;
  email: string;
}

function toView(account: { id: string; username: string; email: string }): AdminAccountView {
  return { id: account.id, username: account.username, email: account.email };
}

// ─── Credential check / password changes ───────────────────────────────────

export async function verifyAdminCredentials(
  username: string,
  password: string
): Promise<AdminAccountView | null> {
  await ensureDefaultAdminAccount();

  const account = await prisma.adminAccount.findUnique({
    where: { username: username.trim() },
  });
  if (!account) return null;
  if (!verifyPasswordHash(password, account.passwordHash)) return null;

  return toView(account);
}

export async function verifyAdminCredentialsByPassword(
  adminId: string,
  password: string
): Promise<boolean> {
  const account = await prisma.adminAccount.findUnique({ where: { id: adminId } });
  if (!account) return false;
  return verifyPasswordHash(password, account.passwordHash);
}

export async function setAdminPassword(adminId: string, newPassword: string): Promise<void> {
  await prisma.adminAccount.update({
    where: { id: adminId },
    data: { passwordHash: hashPassword(newPassword) },
  });
}

// ─── Password reset ─────────────────────────────────────────────────────────

export async function createPasswordResetToken(
  email: string
): Promise<{ token: string; username: string } | null> {
  await ensureDefaultAdminAccount();

  // Case-insensitive match, but there's exactly one admin — no enumeration
  // concern worth hiding behind a fake-success response here.
  const account = await prisma.adminAccount.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
  });
  if (!account) return null;

  const token = randomBytes(32).toString("base64url");
  await prisma.adminAccount.update({
    where: { id: account.id },
    data: {
      resetToken: token,
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  return { token, username: account.username };
}

export async function resetPasswordWithToken(
  token: string,
  newPassword: string
): Promise<boolean> {
  const account = await prisma.adminAccount.findUnique({ where: { resetToken: token } });
  if (!account || !account.resetTokenExpiresAt || account.resetTokenExpiresAt < new Date()) {
    return false;
  }

  await prisma.adminAccount.update({
    where: { id: account.id },
    data: {
      passwordHash: hashPassword(newPassword),
      resetToken: null,
      resetTokenExpiresAt: null,
    },
  });
  return true;
}

// ─── Session cookie ──────────────────────────────────────────────────────────
// Same HMAC-signed-token shape as the Instagram OAuth state in
// lib/meta/oauth.ts — no session table needed for a single admin account.

function signSession(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET")).update(payload).digest("base64url");
}

function buildSessionToken(adminId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ adminId, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 })
  ).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function readSessionToken(token: string): { adminId: string } | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (signature !== signSession(payload)) return null;

  try {
    const { adminId, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof adminId !== "string" || typeof exp !== "number") return null;
    if (Date.now() > exp) return null;
    return { adminId };
  } catch {
    return null;
  }
}

export async function setAdminSessionCookie(adminId: string): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, buildSessionToken(adminId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/admin",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete({ name: ADMIN_SESSION_COOKIE, path: "/admin" });
}

/** Server-side helper: the signed-in admin, or null. Verifies the account
 * still exists (a password reset elsewhere doesn't invalidate old sessions
 * by design — 7-day cookie, low-stakes single-admin setup). */
export async function getAdminSession(): Promise<AdminAccountView | null> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;

  const parsed = readSessionToken(token);
  if (!parsed) return null;

  const account = await prisma.adminAccount.findUnique({ where: { id: parsed.adminId } });
  return account ? toView(account) : null;
}
