import { timingSafeEqual } from "crypto";

/**
 * Cron endpoints authenticate with `Authorization: Bearer <CRON_SECRET>`
 * (NEXTAUTH_SECRET as the legacy fallback). With neither set every request
 * is refused, never matched against the literal "Bearer undefined".
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) return false;

  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
