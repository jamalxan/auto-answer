/**
 * ETAP 5 — the result shape every CRM service function returns to a route:
 * `{ ok: true, data }` or `{ ok: false, status, error }` (Uzbek message).
 * Same contract as lib/javobai/service.ts, kept in its own file so the
 * broadcast engine and the façade can share it without a cycle.
 */

import type { z } from "zod";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({
  ok: false,
  status,
  error,
});

export const done = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

/** Zod's default English messages → plain Uzbek (custom messages pass through untouched). */
function plainMessage(message: string): string {
  if (/^Invalid input: expected .*received undefined/i.test(message)) return "kiritilmagan";
  if (/^Invalid input: expected/i.test(message)) return "noto'g'ri turdagi qiymat";
  if (/^Invalid input$/i.test(message) || /^Invalid (option|value|enum)/i.test(message)) return "noto'g'ri qiymat";
  if (/^Too small/i.test(message)) return "qiymat juda kichik yoki qisqa";
  if (/^Too big/i.test(message)) return "qiymat juda katta yoki uzun";
  if (/^Invalid /i.test(message)) return "noto'g'ri format";
  return message;
}

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Noto'g'ri ma'lumot";
  const path = issue.path.filter((p) => typeof p === "string").join(".");
  const message = plainMessage(issue.message);
  return path ? `${path}: ${message}` : message;
}

/** Prisma unique-constraint violation (P2002), duck-typed so tests can throw it. */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}
