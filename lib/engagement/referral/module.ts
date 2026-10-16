/**
 * ETAP 9.3 / 9.4 — wires the referral and points engines into the engagement
 * worker and the CRM event bus, without editing either:
 *
 *   maintenance task "referral"   attribution scan, then the qualification sweep (every tick)
 *   job "referral-reward"         re-drive one event's reward (lib/engagement/queue REFERRAL_REWARD_JOB)
 *   CRM listener                  interaction (inbound)  → FIRST_MESSAGE qualification, optional comment points
 *                                 lead_created           → LEAD qualification
 *                                 stage_changed WON      → PURCHASE qualification + purchase points
 *
 * Registration is idempotent (maps / a Set keyed by stable references). It is
 * NOT done on import: this module imports lib/engagement/worker.ts, and the
 * worker must not import it back (a cycle would touch the worker's registries
 * before they exist). worker/dm-worker.ts calls registerEngagementReferralModule()
 * once, in the process where the CRM events fire.
 */

import type { Job } from "bullmq";
import { registerCrmListener, type CrmEvent } from "@/lib/crm/hooks";
import { isEngagementEnabled } from "../config";
import { awardPoints } from "../points";
import { REFERRAL_REWARD_JOB } from "../queue";
import { registerEngagementJobHandler, registerEngagementMaintenanceTask } from "../worker";
import { runReferralAttribution } from "./attribution";
import { qualifyReferee, runReferralQualification } from "./qualification";
import { rewardReferralEvent } from "./reward";

export async function runReferralMaintenance(now: Date = new Date()): Promise<void> {
  if (!isEngagementEnabled()) return;
  try {
    const attributed = await runReferralAttribution(now);
    if (attributed.created > 0) console.log("[Engagement] referral attribution:", JSON.stringify(attributed));
  } catch (error) {
    console.error("[Engagement] referral attribution failed:", error instanceof Error ? error.message : error);
  }
  try {
    const qualified = await runReferralQualification(now);
    if (qualified.qualified > 0 || qualified.retried > 0 || qualified.redriven > 0) console.log("[Engagement] referral qualification:", JSON.stringify(qualified));
  } catch (error) {
    console.error("[Engagement] referral qualification failed:", error instanceof Error ? error.message : error);
  }
}

/** The CRM listener; exported for the tests and the worker. */
export async function onCrmEventForEngagement(event: CrmEvent): Promise<void> {
  if (!isEngagementEnabled()) return;
  const accountId = event.contact.instagramAccountId;
  const igUserId = event.contact.igUserId;
  switch (event.kind) {
    case "interaction": {
      if (event.direction !== "inbound") return;
      await qualifyReferee({ instagramAccountId: accountId, refereeIgUserId: igUserId, qualifier: "FIRST_MESSAGE" }, event.at);
      // Comment points exist only when the owner turned them on (awardPoints skips a disabled rule).
      const eventId = event.payload?.eventId;
      if (event.payload?.eventType === "COMMENT" && typeof eventId === "string" && eventId) {
        await awardPoints({
          workspaceId: event.workspaceId,
          contactId: event.contactId,
          reason: "comment",
          sourceTable: "InstagramEvent",
          sourceId: eventId,
          occurredAt: event.at,
        });
      }
      return;
    }
    case "lead_created":
      await qualifyReferee({ instagramAccountId: accountId, refereeIgUserId: igUserId, qualifier: "LEAD" });
      return;
    case "stage_changed":
      if (event.stageKind !== "WON") return;
      await awardPoints({
        workspaceId: event.workspaceId,
        contactId: event.contactId,
        reason: "purchase",
        sourceTable: "CrmDeal",
        sourceId: event.dealId,
      });
      await qualifyReferee({ instagramAccountId: accountId, refereeIgUserId: igUserId, qualifier: "PURCHASE" });
      return;
    default:
      return;
  }
}

async function rewardJob(job: Job): Promise<unknown> {
  if (!isEngagementEnabled()) return { skipped: "ENGAGEMENT_DISABLED" };
  const eventId = (job.data as { eventId?: unknown } | undefined)?.eventId;
  if (typeof eventId !== "string") return { skipped: "no eventId" };
  return rewardReferralEvent(eventId);
}

export function registerEngagementReferralModule(): void {
  registerEngagementMaintenanceTask("referral", () => runReferralMaintenance());
  registerEngagementJobHandler(REFERRAL_REWARD_JOB, rewardJob);
  registerCrmListener(onCrmEventForEngagement);
}
