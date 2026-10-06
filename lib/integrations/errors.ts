/** 401/403 from a CRM: the credentials are no longer valid. Stops retries. */
export class IntegrationAuthError extends Error {
  constructor(
    public provider: string,
    message: string
  ) {
    super(message);
    this.name = "IntegrationAuthError";
  }
}

/** Any other CRM/Telegram failure. Retried with exponential backoff. */
export class IntegrationRequestError extends Error {
  constructor(
    public provider: string,
    public status: number | null,
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "IntegrationRequestError";
  }
}

/** Retry schedule from TZ section 7: 30s, 2m, 10m, 1h, 6h, then dead. */
export const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * Delay before the next attempt after `attemptsMade` failures, or null when the
 * delivery is out of attempts and must be marked dead.
 */
export function nextRetryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.max(0, attemptsMade - 1)];
}
