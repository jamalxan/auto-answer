/**
 * ETAP 6 — publish / unpublish / archive (analysis §3.4). The transaction
 * that gives a flow its seat in the trigger engine: the hidden proxy
 * `TriggerCampaign` (kind FLOW) is created or updated from the Trigger node,
 * so the webhook's claim, matching, priority, cooldown and account gate treat
 * the flow like any other campaign.
 *
 * Enforced here, whatever the caller (the service layer checks the same
 * things earlier to give nicer messages):
 *   - the version belongs to the flow and the workspace, the flow is not archived;
 *   - strict schema parse (flowGraphSchema) and 0 audit errors;
 *   - policy verdict is not BLOCKED;
 *   - decision 1: an AI-generated version needs `testedAt` AND `approvedAt`;
 *     MANUAL / TEMPLATE / IMPORT versions publish directly.
 *
 * Publishing never deactivates another campaign. The previous published
 * version is retired (`retiredAt`) but kept: runs pinned to it keep running
 * on it. Unpublish / archive switch the proxy off; WAITING runs are
 * cancelled by the next maintenance sweep (decision 5).
 */

import { prisma } from "@/lib/db/client";
import type { Flow, Prisma } from "@/app/generated/prisma/client";
import { forgetCommentClaims } from "@/lib/triggers/claim";
import { forgetAccountGate } from "@/lib/triggers/ingest";
import { auditGraph } from "./audit";
import { evaluatePolicy } from "./policy";
import { flowGraphSchema, formatIssues, triggerOf } from "./schema";

export type PublishResult = { ok: true; flow: Flow } | { ok: false; status: number; error: string };
export type SimpleResult = { ok: true; flow: Flow } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export const PUBLISH_ERRORS = {
  notFound: "Oqim yoki versiya topilmadi",
  archived: "Arxivdagi oqimni ishga tushirib bo'lmaydi",
  graph: (first: string) => `Graf to'liq emas: ${first}`,
  audit: (count: number, first: string) => `Audit xatolari bor (${count} ta): ${first}`,
  blocked: (first: string) => `Policy BLOCKED — xabar yuborish qoidalari buzilgan: ${first}`,
  aiNotTested: "AI yaratgan versiyani ishga tushirishdan oldin Test konsolida muvaffaqiyatli sinash kerak",
  aiNotApproved: "AI yaratgan versiya tasdiqsiz ishga tushmaydi — avval tasdiqlang",
  disabled: "Flow'lar o'chirilgan (FLOWS_DISABLED) — ishga tushirib bo'lmaydi",
} as const;

function forgetCaches(account: { id: string; instagramId: string }) {
  forgetAccountGate(account.instagramId);
  forgetCommentClaims(account.id);
}

export async function publishFlowVersion(
  workspaceId: string,
  flowId: string,
  versionId: string,
  actor: { userId: string }
): Promise<PublishResult> {
  const flag = (process.env.FLOWS_DISABLED ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return fail(503, PUBLISH_ERRORS.disabled);

  const flow = await prisma.flow.findFirst({ where: { id: flowId, workspaceId } });
  if (!flow) return fail(404, PUBLISH_ERRORS.notFound);
  const version = await prisma.flowVersion.findFirst({ where: { id: versionId, flowId: flow.id } });
  if (!version) return fail(404, PUBLISH_ERRORS.notFound);
  if (flow.status === "ARCHIVED") return fail(409, PUBLISH_ERRORS.archived);
  const account = await prisma.instagramAccount.findFirst({ where: { id: flow.instagramAccountId, workspaceId }, select: { id: true, instagramId: true } });
  if (!account) return fail(404, PUBLISH_ERRORS.notFound);

  const parsed = flowGraphSchema.safeParse(version.graph);
  if (!parsed.success) return fail(422, PUBLISH_ERRORS.graph(formatIssues(parsed.error)[0] ?? "noma'lum xato"));
  const graph = parsed.data;
  const trigger = triggerOf(graph);
  if (!trigger) return fail(422, PUBLISH_ERRORS.graph("trigger bloki yo'q"));

  const jaAccount = await prisma.javobAiAccount.findFirst({ where: { workspaceId, instagramAccountId: account.id }, select: { mode: true } });
  const javobAiMode = (jaAccount?.mode ?? "OFF") as "OFF" | "SHADOW" | "LIVE";
  const audit = auditGraph(graph, { triggerType: trigger.triggerType, javobAiMode });
  if (audit.errors.length > 0) return fail(422, PUBLISH_ERRORS.audit(audit.errors.length, audit.errors[0].message));
  const policy = evaluatePolicy(graph, { triggerType: trigger.triggerType, javobAiMode });
  if (policy.verdict === "BLOCKED") {
    const first = policy.items.find((item) => item.severity === "BLOCKED");
    return fail(422, PUBLISH_ERRORS.blocked(first?.message ?? "noma'lum sabab"));
  }
  if (version.source === "AI") {
    if (!version.testedAt) return fail(422, PUBLISH_ERRORS.aiNotTested);
    if (!version.approvedAt) return fail(422, PUBLISH_ERRORS.aiNotApproved);
  }

  const now = new Date();
  // The proxy campaign: a 1:1 copy of the Trigger node's matching fields.
  const proxyData = {
    workspaceId,
    instagramAccountId: account.id,
    name: `[Flow] ${flow.name}`.slice(0, 120),
    triggerType: trigger.triggerType,
    storyScope: trigger.storyScope,
    storyIds: trigger.storyIds,
    keywords: trigger.keywords,
    matchingMode: trigger.matchingMode,
    responseType: "SEND_MESSAGE" as const,
    responseMessage: "(flow)",
    active: true,
    mediaScope: trigger.mediaScope,
    mediaIds: trigger.mediaIds,
    intents: trigger.intents,
    priority: trigger.priority,
    publicReplyEnabled: false,
    openingButtonLabel: null,
    mainMessage: null,
    // A flow's runs must not be stopped by the follow-up stop rules (it has no follow-ups).
    stopOnReply: false,
    stopOnLead: false,
    stopOnHandoff: false,
    kind: "FLOW" as const,
    audience: trigger.audience,
    reopenAfterHours: trigger.reopenAfterHours,
    cooldownHours: trigger.cooldownHours,
    sourceFilter: trigger.sourceFilter,
    adIds: trigger.adIds,
    refs: trigger.refs,
  };

  const published = await prisma.$transaction(async (tx) => {
    const existingProxy = flow.proxyCampaignId ? await tx.triggerCampaign.findUnique({ where: { id: flow.proxyCampaignId } }) : null;
    const proxy = existingProxy
      ? await tx.triggerCampaign.update({ where: { id: existingProxy.id }, data: proxyData as Prisma.TriggerCampaignUncheckedUpdateInput })
      : await tx.triggerCampaign.create({ data: proxyData as Prisma.TriggerCampaignUncheckedCreateInput });

    // The previous published version keeps its waiting runs, it just stops being current.
    if (flow.publishedVersionId && flow.publishedVersionId !== version.id) {
      await tx.flowVersion.update({ where: { id: flow.publishedVersionId }, data: { retiredAt: now } });
    }
    await tx.flowVersion.update({
      where: { id: version.id },
      data: { publishedAt: now, publishedByUserId: actor.userId, retiredAt: null },
    });
    return tx.flow.update({
      where: { id: flow.id },
      data: {
        status: "PUBLISHED",
        publishedVersionId: version.id,
        proxyCampaignId: proxy.id,
        triggerType: trigger.triggerType,
        archivedAt: null,
      },
    });
  });

  forgetCaches(account);
  return { ok: true, flow: published };
}

async function switchOff(workspaceId: string, flowId: string, status: "DRAFT" | "ARCHIVED"): Promise<SimpleResult> {
  const flow = await prisma.flow.findFirst({ where: { id: flowId, workspaceId } });
  if (!flow) return fail(404, PUBLISH_ERRORS.notFound);
  const account = await prisma.instagramAccount.findFirst({ where: { id: flow.instagramAccountId }, select: { id: true, instagramId: true } });
  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    if (flow.proxyCampaignId) {
      await tx.triggerCampaign.updateMany({ where: { id: flow.proxyCampaignId, workspaceId }, data: { active: false } });
    }
    if (flow.publishedVersionId) {
      await tx.flowVersion.update({ where: { id: flow.publishedVersionId }, data: { retiredAt: now } });
    }
    return tx.flow.update({
      where: { id: flow.id },
      data: { status, publishedVersionId: null, ...(status === "ARCHIVED" ? { archivedAt: now } : {}) },
    });
  });
  if (account) forgetCaches(account);
  return { ok: true, flow: updated };
}

/** Switch the flow off (DRAFT keeps it editable, ARCHIVED shelves it). WAITING runs are cancelled by the next sweep. */
export async function unpublishFlow(workspaceId: string, flowId: string, to: "DRAFT" | "ARCHIVED" = "DRAFT"): Promise<SimpleResult> {
  return switchOff(workspaceId, flowId, to);
}

export async function archiveFlow(workspaceId: string, flowId: string): Promise<SimpleResult> {
  return switchOff(workspaceId, flowId, "ARCHIVED");
}
