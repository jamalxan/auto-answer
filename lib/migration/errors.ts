/**
 * ETAP 11 — one error type for the migration DB layer. `status` is the HTTP
 * status the API route answers with; the message is the Uzbek text shown to
 * the user. Same contract as lib/flows/errors and lib/crm/errors.
 */

export class MigrationServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "MigrationServiceError";
  }
}

export const notFound = (message: string) => new MigrationServiceError(404, message);
export const badRequest = (message: string) => new MigrationServiceError(400, message);
export const unprocessable = (message: string) => new MigrationServiceError(422, message);

export function isMigrationServiceError(error: unknown): error is MigrationServiceError {
  return error instanceof MigrationServiceError;
}

/** `{ ok: false, status, error }` for the route façade when a service throws. */
export function toMigrationFailure(error: unknown): { ok: false; status: number; error: string } {
  if (isMigrationServiceError(error)) return { ok: false, status: error.status, error: error.message };
  return { ok: false, status: 500, error: "Kutilmagan xato — birozdan keyin qayta urinib ko'ring" };
}

/** What is safe to log about a provider failure: class and HTTP status only (no body, no key, no message). */
export function describeProviderError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${name} ${status}` : name;
}
