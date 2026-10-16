/**
 * ETAP 12 — one error type for the MCP service layer. `message` is the Uzbek
 * text the AI client (and its user) sees as a tool error; `status` follows the
 * HTTP conventions of the other services.
 */

import { isCrmServiceError } from "@/lib/crm/errors";
import { isFlowServiceError } from "@/lib/flows/errors";

export class McpServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "McpServiceError";
  }
}

export const notFound = (message: string) => new McpServiceError(404, message);
export const badRequest = (message: string) => new McpServiceError(400, message);
export const forbidden = (message: string) => new McpServiceError(403, message);
export const conflict = (message: string) => new McpServiceError(409, message);

export const UNEXPECTED_MESSAGE = "Kutilmagan xato — birozdan keyin qayta urinib ko'ring";

/** The message that is safe to show for any thrown value; unknown errors are never echoed (they may carry internals). */
export function safeMessage(error: unknown): string {
  if (error instanceof McpServiceError) return error.message;
  if (isFlowServiceError(error)) return error.message;
  if (isCrmServiceError(error)) return error.message;
  return UNEXPECTED_MESSAGE;
}

/** What may be logged about a failure: class name and HTTP-ish status only. */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${name} ${status}` : name;
}
