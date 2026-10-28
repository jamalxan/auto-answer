import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { FLASH_COOKIE, type Flash } from "@/lib/flash";

/** Redirect to a dashboard page carrying a one-shot notice in a cookie, not in the URL. */
export function flashRedirect(path: string, flash: Flash): NextResponse {
  // cookies.set percent-encodes the value itself; the page decodes it once.
  const response = NextResponse.redirect(`${getBaseUrl()}${path}`);
  response.cookies.set(FLASH_COOKIE, JSON.stringify(flash), {
    path: "/",
    maxAge: 120,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // The page has to read and clear it, and it carries nothing secret.
    httpOnly: false,
  });
  return response;
}
