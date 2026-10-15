"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  verifyAdminCredentials,
  setAdminSessionCookie,
  clearAdminSessionCookie,
  getAdminSession,
  setAdminPassword,
  verifyAdminCredentialsByPassword,
  createPasswordResetToken,
  resetPasswordWithToken,
} from "@/lib/admin/auth";
import { sendEmail } from "@/lib/email";
import { getRedisConnection } from "@/lib/queue/client";

// Failed admin logins per client IP. The account guards every tenant, so a
// password guessing loop gets cut off after a handful of misses.
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

async function loginFailureKey(): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
  return `admin-login-failures:${ip}`;
}

// Redis being down must not lock the admin out, so the limiter fails open.
async function loginFailureCount(key: string): Promise<number> {
  try {
    return Number(await getRedisConnection().get(key)) || 0;
  } catch (err) {
    console.error("[admin] login limiter unavailable:", err);
    return 0;
  }
}

async function recordLoginFailure(key: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
  } catch (err) {
    console.error("[admin] login limiter unavailable:", err);
  }
}

export async function adminLoginAction(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");

  const failureKey = await loginFailureKey();
  if ((await loginFailureCount(failureKey)) >= LOGIN_FAILURE_LIMIT) {
    redirect("/admin/login?error=locked");
  }

  const account = await verifyAdminCredentials(username, password);
  if (!account) {
    await recordLoginFailure(failureKey);
    redirect("/admin/login?error=invalid");
  }

  await setAdminSessionCookie(account.id);
  redirect("/admin");
}

export async function adminLogoutAction(): Promise<void> {
  await clearAdminSessionCookie();
  redirect("/admin/login");
}

export async function adminChangePasswordAction(formData: FormData): Promise<void> {
  const session = await getAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword.length < 8) {
    redirect("/admin/settings?error=too_short");
  }
  if (newPassword !== confirmPassword) {
    redirect("/admin/settings?error=mismatch");
  }

  const ok = await verifyAdminCredentialsByPassword(session.id, currentPassword);
  if (!ok) {
    redirect("/admin/settings?error=wrong_current");
  }

  await setAdminPassword(session.id, newPassword);
  redirect("/admin/settings?success=1");
}

export async function adminForgotPasswordAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");

  const result = await createPasswordResetToken(email);
  // Same response either way — this page never confirms or denies whether a
  // given address is the admin's.
  if (result) {
    const base = process.env.NEXTAUTH_URL ?? "";
    const resetUrl = `${base}/admin/reset-password/${result.token}`;
    await sendEmail({
      to: email.trim(),
      subject: "SocialAuto admin — password reset",
      text:
        `A password reset was requested for the SocialAuto admin panel (user: ${result.username}).\n\n` +
        `Reset your password: ${resetUrl}\n\n` +
        `This link expires in 1 hour. If you didn't request this, ignore this email.`,
      html:
        `<p>A password reset was requested for the SocialAuto admin panel (user: <b>${result.username}</b>).</p>` +
        `<p><a href="${resetUrl}">Reset your password</a></p>` +
        `<p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
    }).catch((err) => {
      console.error("[admin] failed to send password reset email:", err);
    });
  }

  redirect("/admin/forgot-password?sent=1");
}

export async function adminResetPasswordAction(
  token: string,
  formData: FormData
): Promise<void> {
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword.length < 8) {
    redirect(`/admin/reset-password/${token}?error=too_short`);
  }
  if (newPassword !== confirmPassword) {
    redirect(`/admin/reset-password/${token}?error=mismatch`);
  }

  const ok = await resetPasswordWithToken(token, newPassword);
  if (!ok) {
    redirect(`/admin/reset-password/${token}?error=invalid_token`);
  }

  redirect("/admin/login?reset=1");
}
