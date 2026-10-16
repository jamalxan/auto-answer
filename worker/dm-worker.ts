import { createDMWorker } from "@/lib/queue/dm-worker";
import { createAssistantWorker, runAssistantMaintenance } from "@/lib/queue/assistant-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { isTriggerEngineEnabled } from "@/lib/triggers/config";
import { createTriggerWorker, runTriggerMaintenance } from "@/lib/triggers/worker";
import { isJavobAiEnabled } from "@/lib/javobai/config";
import { createJavobAiWorker, runJavobAiMaintenance } from "@/lib/javobai/worker";
import { createCrmWorker, isCrmEnabled, runCrmMaintenance } from "@/lib/crm/worker";
import { registerBroadcastModule } from "@/lib/crm/broadcast-worker";
import os from "node:os";

const worker = createDMWorker();
// Lead assistant + CRM deliveries run on their own queue so a slow CRM or LLM
// can never hold up campaign DMs.
const assistantWorker = createAssistantWorker();
// Instagram Trigger Engine (dev): its own queue, off with TRIGGER_ENGINE_DISABLED.
const triggerWorker = isTriggerEngineEnabled() ? createTriggerWorker() : null;
// JavobAI (dev): its own queue, off with JAVOBAI_DISABLED.
const javobAiWorker = isJavobAiEnabled() ? createJavobAiWorker() : null;
// CRM (dev, ETAP 5): the "crm" queue (contact sync + broadcast jobs), opt-in with CRM_ENABLED=1, CRM_DISABLED=1 wins.
if (isCrmEnabled()) registerBroadcastModule();
const crmWorker = isCrmEnabled() ? createCrmWorker() : null;
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// Re-queue deliveries that are due but have no live job (Redis flush, crash).
const maintenanceTimer = setInterval(() => {
  void runAssistantMaintenance();
  if (triggerWorker) void runTriggerMaintenance();
  if (javobAiWorker) void runJavobAiMaintenance();
  // Reconciler every 5 min (self-throttled) plus the registered tasks (broadcast) every minute.
  if (crmWorker) void runCrmMaintenance();
}, 60_000);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(maintenanceTimer);
  await worker.close();
  await assistantWorker.close();
  await triggerWorker?.close();
  await javobAiWorker?.close();
  await crmWorker?.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
