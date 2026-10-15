"use server";

import { redirect } from "next/navigation";
import { loginThrottle } from "@/lib/utils/login-throttle";
import {
  clearDeveloperSessionCookie,
  setDeveloperSessionCookie,
  verifyDeveloperCredentials,
} from "./auth";

export async function developerLoginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const throttle = await loginThrottle("developer");
  if (await throttle.isLocked()) {
    redirect("/developer/login?error=locked");
  }

  if (!verifyDeveloperCredentials(email, password)) {
    await throttle.recordFailure();
    redirect("/developer/login?error=invalid");
  }

  await setDeveloperSessionCookie();
  redirect("/developer");
}

export async function developerLogoutAction(): Promise<void> {
  await clearDeveloperSessionCookie();
  redirect("/developer/login");
}
