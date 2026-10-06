import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { processDelivery, sweepDueDeliveries } from "@/lib/leads/delivery";
import { handleEcho, handleInboundMessage, runAssistantReply } from "@/lib/assistant/engine";
import { runGapDigest, runPriceReminders, runOnboardingReminders } from "@/lib/telegram/owner-notifications";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import {
  ASSISTANT_QUEUE_NAME,
  DELIVER_JOB,
  ECHO_JOB,
  INBOUND_JOB,
  NOTIFY_JOB,
  REPLY_JOB,
  type AssistantJob,
  type DeliverJob,
  type EchoJob,
  type InboundJob,
  type NotifyJob,
  type ReplyJob,
} from "./assistant-queue";
import { getRedisConnection } from "./client";

async function processNotify(job: Job<NotifyJob>) {
  const data = job.data;
  if (data.kind === "customer_wrote_again" && data.conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: data.conversationId },
      select: { workspaceId: true, igUsername: true, igName: true },
    });
    if (!conversation) return;
    const who = conversation.igUsername ? `@${conversation.igUsername}` : (conversation.igName ?? "mijoz");
    await notifyWorkspaceChats(
      conversation.workspaceId,
      `💬 <b>Mijoz yana yozdi</b> — ${esc(who)}\nOperator Instagram'da javob bersin.`,
      {
        keyboard: [
          [{ text: "💬 Instagram suhbat", url: `${getBaseUrl()}/inbox?conversation=${data.conversationId}` }],
        ],
      }
    );
    return;
  }
  if (data.kind === "gap_digest") return void (await runGapDigest());
  if (data.kind === "price_reminder") return void (await runPriceReminders());
  if (data.kind === "onboarding_reminder") return void (await runOnboardingReminders());
}

async function processJob(job: Job<AssistantJob>): Promise<void> {
  if (job.name === DELIVER_JOB) return processDelivery((job as Job<DeliverJob>).data.deliveryId);
  if (job.name === REPLY_JOB) return runAssistantReply((job as Job<ReplyJob>).data.conversationId);
  if (job.name === INBOUND_JOB) return handleInboundMessage((job as Job<InboundJob>).data);
  if (job.name === ECHO_JOB) return handleEcho((job as Job<EchoJob>).data);
  if (job.name === NOTIFY_JOB) return processNotify(job as Job<NotifyJob>);
}

export function createAssistantWorker(): Worker<AssistantJob> {
  const worker = new Worker<AssistantJob>(ASSISTANT_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 8,
  });

  worker.on("failed", (job, err) => {
    console.error(`[Assistant Worker] job ${job?.id} (${job?.name}) failed:`, err.stack ?? err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `Assistant job ${job?.name ?? "?"} failed: ${err.message}`.slice(0, 500),
          payload: { jobId: job?.id ?? null },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[Assistant Worker] error:", err.message);
  });

  return worker;
}

/** Periodic housekeeping, called from the worker process on a timer. */
export async function runAssistantMaintenance(): Promise<void> {
  await sweepDueDeliveries().catch((e) => console.error("[Assistant] sweep failed:", e.message));
}
