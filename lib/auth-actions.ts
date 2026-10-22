"use server";

import { signOut } from "@/lib/auth";

/**
 * Ends the customer session (NextAuth database session + cookie) and lands
 * on the login page. Used by the account menu in the dashboard sidebar.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
