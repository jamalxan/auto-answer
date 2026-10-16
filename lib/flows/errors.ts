/**
 * ETAP 6/7 — one error type for the Flow DB layer. `status` is the HTTP
 * status the API route answers with; the message is the Uzbek text shown to
 * the user. Same contract as lib/crm/errors.
 */

export class FlowServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "FlowServiceError";
  }
}

export const notFound = (message: string) => new FlowServiceError(404, message);
export const unprocessable = (message: string) => new FlowServiceError(422, message);
export const badRequest = (message: string) => new FlowServiceError(400, message);

export function isFlowServiceError(error: unknown): error is FlowServiceError {
  return error instanceof FlowServiceError;
}

export function toFlowFailure(error: unknown): { ok: false; status: number; error: string } {
  if (isFlowServiceError(error)) return { ok: false, status: error.status, error: error.message };
  return { ok: false, status: 500, error: error instanceof Error ? error.message : "Noma'lum xato" };
}
