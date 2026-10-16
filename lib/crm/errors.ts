/**
 * ETAP 5 — one error type for the CRM DB layer (tags, segments, team,
 * assignment, export). `status` is the HTTP status the API route answers
 * with; the message is the Uzbek text shown to the user.
 */

export class CrmServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CrmServiceError";
  }
}

export const notFound = (message: string) => new CrmServiceError(404, message);
export const forbidden = (message: string) => new CrmServiceError(403, message);
export const unprocessable = (message: string) => new CrmServiceError(422, message);

export function isCrmServiceError(error: unknown): error is CrmServiceError {
  return error instanceof CrmServiceError;
}

/** `{ ok: false, status, error }` for the route façade (lib/crm/result.ts) when a service throws. */
export function toServiceFailure(error: unknown): { ok: false; status: number; error: string } {
  if (isCrmServiceError(error)) return { ok: false, status: error.status, error: error.message };
  return { ok: false, status: 500, error: error instanceof Error ? error.message : "Noma'lum xato" };
}

export { isUniqueViolation } from "./result";
