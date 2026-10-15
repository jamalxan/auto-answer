import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

// The Redis client retries forever (BullMQ needs maxRetriesPerRequest: null),
// so a dead Redis would hang the whole request — and the deploy smoke test
// with it. Every check gets a deadline instead.
const CHECK_TIMEOUT_MS = 3000;

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} check timed out`)), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await withDeadline(prisma.$queryRaw`SELECT 1`, "Database");
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    const pong = await withDeadline(getRedisConnection().ping(), "Redis");
    return { status: pong === "PONG" ? "ok" : "error", detail: pong };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Redis check failed",
    };
  }
}

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const counts = await withDeadline(
      getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      "Queue"
    );
    return { status: "ok", counts };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

export async function GET(request: Request) {
  const [database, redis, queue, worker] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    withDeadline(getWorkerHealth(), "Worker").catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  // The endpoint is public (deploy smoke tests, uptime checks), so anonymous
  // callers only get the statuses. Error text, queue depth and the worker's
  // hostname/pid need the cron secret.
  const checks = isAuthorizedCronRequest(request)
    ? { database, redis, queue, worker }
    : {
        database: { status: database.status },
        redis: { status: redis.status },
        queue: { status: queue.status },
        worker: { healthy: worker.healthy, ageMs: worker.ageMs },
      };

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
