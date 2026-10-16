/**
 * Integration health check (B-04): every 5 minutes the worker runs a real API
 * call against each amoCRM / Bitrix24 integration (ACTIVE and BROKEN ones), so
 * a revoked or expired token flips the status within minutes (typed
 * INTEGRATION_AUTH_EXPIRED, owner alerted once) and a repaired one releases
 * its held leads without waiting for someone to press "Qayta tekshirish".
 */

import { prisma } from "@/lib/db/client";
import { runConnectionCheck } from "./service";

export const INTEGRATION_CHECK_INTERVAL_MS = 5 * 60_000;

let lastRunAt = 0;

/** At most this many integrations are checked at once (one slow CRM must not stall the rest). */
export const HEALTH_CHECK_CONCURRENCY = 3;
/** A check that takes longer is abandoned for this round (status unchanged, retried in 5 minutes). */
export const HEALTH_CHECK_TIMEOUT_MS = 8_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runIntegrationHealthChecks(): Promise<{ checked: number; broken: number; timedOut: number }> {
  const integrations = await prisma.integration.findMany({
    where: { type: { in: ["AMOCRM", "BITRIX24"] }, status: { in: ["ACTIVE", "BROKEN"] } },
    select: { id: true },
  });
  let broken = 0;
  let timedOut = 0;
  let next = 0;
  const worker = async () => {
    while (next < integrations.length) {
      const { id } = integrations[next++];
      try {
        const result = await withTimeout(runConnectionCheck(id), HEALTH_CHECK_TIMEOUT_MS);
        if (!result.ok && result.reason === "auth") broken++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("health check timed out")) timedOut++;
        console.error("[Integrations] health check failed:", message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEALTH_CHECK_CONCURRENCY, integrations.length) }, worker));
  return { checked: integrations.length, broken, timedOut };
}

/** Called every minute by the worker; runs the checks at most every 5 minutes. */
export async function runIntegrationHealthMaintenance(now = Date.now()): Promise<void> {
  if (now - lastRunAt < INTEGRATION_CHECK_INTERVAL_MS) return;
  lastRunAt = now;
  try {
    await runIntegrationHealthChecks();
  } catch (error) {
    console.error("[Integrations] health maintenance failed:", error instanceof Error ? error.message : error);
  }
}
