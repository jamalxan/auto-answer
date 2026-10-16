/**
 * ETAP 11 — in-process guards next to the database counters.
 *
 * The hourly AI cap counts `LlmUsage` rows, but a row is written only AFTER the
 * provider answered, so parallel requests could all pass the count, and a
 * failed usage write would not count at all. This module keeps, per server
 * process, (a) every attempt of the last hour (a floor under the database
 * count, reserved synchronously right after the check) and (b) the number of
 * AI calls in flight (at most MAX_CONCURRENT_AI_CALLS per workspace).
 *
 * Residual bound: the floor is per process, so with N web processes a workspace
 * can still reach about N x the hourly cap in a burst; the database count
 * catches up as soon as the usage rows are written. Documented in README.
 */

import { CONNECTS_PER_HOUR, CONVERSIONS_PER_HOUR, MAX_CONCURRENT_AI_CALLS } from "./config";
import { MigrationServiceError } from "./errors";

const HOUR_MS = 3_600_000;

const aiAttempts = new Map<string, number[]>();
const aiInFlight = new Map<string, number>();
const connectAttempts = new Map<string, number[]>();

const recent = (map: Map<string, number[]>, key: string, now: number): number[] => {
  const list = (map.get(key) ?? []).filter((t) => t > now - HOUR_MS);
  map.set(key, list);
  return list;
};

export const CONCURRENCY_MESSAGE = `Bir vaqtning o'zida ${MAX_CONCURRENT_AI_CALLS} tadan ortiq AI so'rovi mumkin emas — avvalgisi tugashini kuting`;
export const CONNECT_THROTTLE_MESSAGE = `Soatiga ${CONNECTS_PER_HOUR} tadan ko'p ulanish urinishi mumkin emas — birozdan keyin qayta urinib ko'ring`;

/**
 * Reserves one AI call (hourly floor + concurrency slot). `dbCount` is the
 * stored count of the last hour; the larger of it and the in-memory attempts
 * is checked. Returns the release function (call it in `finally`).
 */
export function reserveAiCall(workspaceId: string, dbCount: number, rateLimitMessage: string, now = Date.now()): () => void {
  const attempts = recent(aiAttempts, workspaceId, now);
  if (Math.max(dbCount, attempts.length) >= CONVERSIONS_PER_HOUR) throw new MigrationServiceError(429, rateLimitMessage);
  const running = aiInFlight.get(workspaceId) ?? 0;
  if (running >= MAX_CONCURRENT_AI_CALLS) throw new MigrationServiceError(429, CONCURRENCY_MESSAGE);
  attempts.push(now);
  aiInFlight.set(workspaceId, running + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (aiInFlight.get(workspaceId) ?? 1) - 1;
    if (left <= 0) aiInFlight.delete(workspaceId);
    else aiInFlight.set(workspaceId, left);
  };
}

/** Counts one connect attempt, or throws 429 when the workspace already used its hourly attempts. */
export function reserveConnectAttempt(workspaceId: string, now = Date.now()): void {
  const attempts = recent(connectAttempts, workspaceId, now);
  if (attempts.length >= CONNECTS_PER_HOUR) throw new MigrationServiceError(429, CONNECT_THROTTLE_MESSAGE);
  attempts.push(now);
}

export function resetMigrationLimitsForTests(): void {
  aiAttempts.clear();
  aiInFlight.clear();
  connectAttempts.clear();
}
