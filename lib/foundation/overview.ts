/**
 * Everything the Foundation screen needs in one call: connections, queue and
 * the diagnostics built from them (loaded once, shared with diagnostics).
 */

import { getWorkerHealth } from "@/lib/ops/worker-health";
import { loadConnections, type ConnectionView } from "./connections";
import { runDiagnostics, type DiagnosticItem } from "./diagnostics";
import { loadQueueStats, type QueueStats } from "./queue-stats";
import { withTimeout } from "./time";

export interface FoundationOverview {
  connections: ConnectionView[];
  queue: QueueStats;
  /** null when Redis did not answer. */
  workerHealthy: boolean | null;
  diagnostics: DiagnosticItem[];
  generatedAt: string;
}

export async function loadFoundationOverview(workspaceId: string, now: Date = new Date()): Promise<FoundationOverview> {
  const connections = await loadConnections(workspaceId, now);
  const [queue, worker] = await Promise.all([
    loadQueueStats(workspaceId, {
      now,
      accounts: connections.map((c) => ({ id: c.id, username: c.username, instagramId: c.instagramId })),
    }),
    withTimeout(getWorkerHealth()),
  ]);
  // Only the healthy flag and age leave the server: the heartbeat itself is
  // platform-wide (hostname, pid) and not this workspace's data.
  const workerInput = worker ? { healthy: worker.healthy, ageMs: worker.ageMs } : null;
  const diagnostics = await runDiagnostics(workspaceId, { connections, queue, worker: workerInput }, now);

  return {
    connections,
    queue,
    workerHealthy: workerInput?.healthy ?? null,
    diagnostics,
    generatedAt: now.toISOString(),
  };
}
