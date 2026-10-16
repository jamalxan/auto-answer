/**
 * ETAP 9 — one error type for the engagement service layer. `status` is the
 * HTTP status the API route answers with; the message is the Uzbek text shown
 * to the user.
 */

export class EngagementServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "EngagementServiceError";
  }
}

export const notFound = (message: string) => new EngagementServiceError(404, message);
export const conflict = (message: string) => new EngagementServiceError(409, message);
export const unprocessable = (message: string) => new EngagementServiceError(422, message);

export function isEngagementServiceError(error: unknown): error is EngagementServiceError {
  return error instanceof EngagementServiceError;
}
