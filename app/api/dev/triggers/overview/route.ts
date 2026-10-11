import { jsonOk } from "@/lib/api-auth";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { requireTriggerDev } from "@/lib/triggers/access";
import { isTriggerEngineEnabled } from "@/lib/triggers/config";
import { getTriggerQueue } from "@/lib/triggers/queue";
import { getEngineOverview } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

// The shared Redis client retries forever, so a Redis outage would hang this
// status page instead of reporting it.
function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function GET() {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;

  const [overview, queue, worker] = await Promise.all([
    getEngineOverview(auth.ctx.workspaceId),
    withTimeout(getTriggerQueue().getJobCounts("waiting", "active", "delayed", "failed", "completed")),
    withTimeout(getWorkerHealth()),
  ]);

  return jsonOk({
    enabled: isTriggerEngineEnabled(),
    queue,
    workerHealthy: worker?.healthy ?? false,
    ...overview,
  });
}
