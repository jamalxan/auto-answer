/**
 * ETAP 6/7 — what the auditor, the policy engine and the AI builder need to
 * know about the workspace: CRM tags / stages, price policy of the profile,
 * JavobAI mode of the account, product lines. One loader, workspace scoped.
 */

import { prisma } from "@/lib/db/client";
import type { AuditContext } from "./audit";
import type { FlowTriggerType } from "./schema";

export interface FlowWorkspaceContext {
  declaredTags: string[];
  stages: Array<{ id: string; name: string; pipelineName: string }>;
  pricePolicy: "NEVER" | "FROM_ONLY" | "EXACT";
  javobAiMode: "OFF" | "SHADOW" | "LIVE";
  brand: string | null;
  /** Product / price lines the AI builder may quote. */
  kb: string[];
}

export async function loadFlowContext(workspaceId: string, instagramAccountId: string): Promise<FlowWorkspaceContext> {
  const [tags, pipelines, profiles, jaAccount] = await Promise.all([
    prisma.crmTag.findMany({ where: { workspaceId }, select: { slug: true } }),
    prisma.crmPipeline.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
    prisma.assistantProfile.findMany({ where: { workspaceId, OR: [{ instagramAccountId }, { instagramAccountId: null }] } }),
    prisma.javobAiAccount.findFirst({ where: { workspaceId, instagramAccountId }, select: { mode: true } }),
  ]);
  const pipelineIds = pipelines.map((p) => p.id);
  const stageRows = pipelineIds.length ? await prisma.crmStage.findMany({ where: { pipelineId: { in: pipelineIds } }, orderBy: { sort: "asc" } }) : [];
  const pipelineName = new Map(pipelines.map((p) => [p.id, p.name]));
  // Account-specific profile first, then the workspace-wide one.
  const profile = profiles.find((p) => p.instagramAccountId === instagramAccountId) ?? profiles.find((p) => p.instagramAccountId === null) ?? null;
  let kb: string[] = [];
  if (profile) {
    const products = await prisma.assistantProduct.findMany({ where: { profileId: profile.id }, orderBy: { sort: "asc" }, take: 20 });
    const showPrice = profile.pricePolicy !== "NEVER";
    kb = products.map((p) => {
      const price = showPrice && p.price !== null && p.price !== undefined ? ` — ${p.priceIsFrom ? "dan " : ""}${String(p.price)} ${p.currency}` : "";
      return `${p.name}${price}`;
    });
    if (profile.address) kb.push(`Manzil: ${profile.address}`);
  }
  return {
    declaredTags: tags.map((t) => t.slug),
    stages: stageRows.map((s) => ({ id: s.id, name: s.name, pipelineName: pipelineName.get(s.pipelineId) ?? "" })),
    pricePolicy: (profile?.pricePolicy ?? "NEVER") as FlowWorkspaceContext["pricePolicy"],
    javobAiMode: (jaAccount?.mode ?? "OFF") as FlowWorkspaceContext["javobAiMode"],
    brand: profile?.companyName ? [profile.companyName, profile.description].filter(Boolean).join(" — ").slice(0, 300) : null,
    kb,
  };
}

export function auditContextFrom(ctx: FlowWorkspaceContext, triggerType?: FlowTriggerType): AuditContext {
  return {
    triggerType,
    declaredTags: ctx.declaredTags,
    stages: ctx.stages.map((s) => s.id),
    pricePolicy: ctx.pricePolicy,
    javobAiMode: ctx.javobAiMode,
  };
}
