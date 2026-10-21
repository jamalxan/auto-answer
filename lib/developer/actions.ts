"use server";

import { redirect } from "next/navigation";
import { loginThrottle } from "@/lib/utils/login-throttle";
import { safeDeveloperNext } from "./safe-next";
import {
  clearDeveloperSessionCookie,
  setDeveloperSessionCookie,
  verifyDeveloperCredentials,
} from "./auth";

export async function developerLoginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeDeveloperNext(formData.get("next"));
  const back = (error: string) => `/developer/login?error=${error}${next ? `&next=${encodeURIComponent(next)}` : ""}`;

  const throttle = await loginThrottle("developer");
  if (await throttle.isLocked()) {
    redirect(back("locked"));
  }

  if (!verifyDeveloperCredentials(email, password)) {
    await throttle.recordFailure();
    redirect(back("invalid"));
  }

  await setDeveloperSessionCookie();
  redirect(next ?? "/developer");
}

export async function developerLogoutAction(): Promise<void> {
  await clearDeveloperSessionCookie();
  redirect("/developer/login");
}
