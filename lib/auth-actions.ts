"use server";

import { signOut } from "@/lib/auth";

/** Ends the app session (deletes the database session row and its cookie) and goes to the login page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
