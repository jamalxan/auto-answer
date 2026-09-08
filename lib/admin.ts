/**
 * Platform-admin allowlist for the internal /admin panel (cross-workspace
 * overview: all workspaces, owners, and usage — not a per-workspace role).
 * Comma-separated email list via ADMIN_EMAILS. Unset means nobody can reach
 * /admin, rather than defaulting open like ALLOWED_EMAILS does for sign-in.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return admins.includes(email.toLowerCase());
}
