/**
 * Content intelligence worker tick, from the content worker's minute loop
 * (off with CONTENT_INTEL_DISABLED=1):
 *
 *   every minute   two queued video analyses
 *   every 30 min   stats of connected accounts (each account re-reads only
 *                  stale posts, see refreshAfterMs), Trial Reels experiments,
 *                  the weekly reports (sent once, Monday 09:00 workspace time)
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

const SLOW_EVERY_SEC = 30 * 60;

export function contentIntelEnabled(): boolean {
  return process.env.CONTENT_INTEL_DISABLED !== "1";
}

async function slowTurn(): Promise<boolean> {
  try {
    return (await getRedisConnection().set("content-intel:slow", "1", "EX", SLOW_EVERY_SEC, "NX")) === "OK";
  } catch {
    return false;
  }
}

export interface TickResult {
  analysed: number;
  accounts: number;
  experiments: number;
  reports: number;
}

export async function contentIntelTick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { analysed: 0, accounts: 0, experiments: 0, reports: 0 };
  if (!contentIntelEnabled()) return result;
  const { processAnalysisQueue } = await import("./analyze");
  result.analysed = await processAnalysisQueue(2);
  if (!(await slowTurn())) return result;

  const { collectAccountStats } = await import("./metrics");
  const accounts = await prisma.instagramAccount.findMany({ where: { tokenStatus: "ACTIVE" }, select: { id: true } });
  for (const account of accounts) {
    const collected = await collectAccountStats(account.id, now).catch((error) => {
      console.error("[ContentIntel] collect failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (collected?.fetched) result.accounts++;
  }
  const { evaluateExperiments } = await import("./experiments");
  result.experiments = await evaluateExperiments(now).catch(() => 0);
  const { runWeeklyReports } = await import("./report");
  result.reports = await runWeeklyReports(now).catch((error) => {
    console.error("[ContentIntel] weekly reports failed:", error instanceof Error ? error.message : error);
    return 0;
  });
  return result;
}
