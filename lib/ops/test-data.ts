/**
 * Test objects in a production workspace (audit 2026-10-26: "TEST Claude…"
 * campaigns and test leads skew the statistics). One list, one delete:
 *
 *   - comment / trigger campaigns whose name starts with "TEST" and that are OFF
 *   - flows whose name starts with "TEST" that were never published
 *   - leads with isTest (JavobAI sandbox, flow "mark_test")
 *
 * The delete takes the ids the owner saw and removes only those that still
 * match the rule at delete time, so a campaign renamed or switched on in
 * between is never touched.
 */

import { prisma } from "@/lib/db/client";

export interface TestDataItem {
  kind: "campaign" | "flow" | "lead";
  id: string;
  label: string;
  createdAt: Date;
}

const TEST_NAME = { startsWith: "TEST", mode: "insensitive" as const };

function campaignWhere(workspaceId: string, ids?: string[]) {
  // Flow proxies are deleted with their flow, never on their own.
  return { workspaceId, kind: "CAMPAIGN" as const, active: false, name: TEST_NAME, ...(ids ? { id: { in: ids } } : {}) };
}
function flowWhere(workspaceId: string, ids?: string[]) {
  return { workspaceId, name: TEST_NAME, publishedVersionId: null, ...(ids ? { id: { in: ids } } : {}) };
}
function leadWhere(workspaceId: string, ids?: string[]) {
  return { workspaceId, isTest: true, ...(ids ? { id: { in: ids } } : {}) };
}

export async function findTestData(workspaceId: string): Promise<TestDataItem[]> {
  const [campaigns, flows, leads] = await Promise.all([
    prisma.triggerCampaign.findMany({ where: campaignWhere(workspaceId), select: { id: true, name: true, createdAt: true }, take: 200 }),
    prisma.flow.findMany({ where: flowWhere(workspaceId), select: { id: true, name: true, createdAt: true }, take: 200 }),
    prisma.lead.findMany({ where: leadWhere(workspaceId), select: { id: true, name: true, igUsername: true, phoneE164: true, createdAt: true }, take: 500 }),
  ]);
  return [
    ...(campaigns as Array<{ id: string; name: string; createdAt: Date }>).map((c) => ({ kind: "campaign" as const, id: c.id, label: c.name, createdAt: c.createdAt })),
    ...(flows as Array<{ id: string; name: string; createdAt: Date }>).map((f) => ({ kind: "flow" as const, id: f.id, label: f.name, createdAt: f.createdAt })),
    ...(leads as Array<{ id: string; name: string | null; igUsername: string | null; phoneE164: string | null; createdAt: Date }>).map((l) => ({
      kind: "lead" as const,
      id: l.id,
      label: l.name || (l.igUsername ? `@${l.igUsername}` : null) || l.phoneE164 || "Test lid",
      createdAt: l.createdAt,
    })),
  ];
}

export async function deleteTestData(workspaceId: string, items: Array<{ kind: string; id: string }>): Promise<{ campaigns: number; flows: number; leads: number }> {
  const ids = (kind: string) => items.filter((i) => i.kind === kind).map((i) => i.id).slice(0, 500);
  // A draft flow may still own a hidden proxy campaign from an earlier publish: it goes with the flow.
  const proxies = (await prisma.flow.findMany({ where: flowWhere(workspaceId, ids("flow")), select: { proxyCampaignId: true } })) as Array<{ proxyCampaignId: string | null }>;
  const proxyIds = proxies.map((p) => p.proxyCampaignId).filter((id): id is string => Boolean(id));
  const [campaigns, flows, leads] = await prisma.$transaction([
    prisma.triggerCampaign.deleteMany({ where: campaignWhere(workspaceId, ids("campaign")) }),
    prisma.flow.deleteMany({ where: flowWhere(workspaceId, ids("flow")) }),
    prisma.lead.deleteMany({ where: leadWhere(workspaceId, ids("lead")) }),
    prisma.triggerCampaign.deleteMany({ where: { workspaceId, kind: "FLOW", id: { in: proxyIds } } }),
  ]);
  return { campaigns: campaigns.count, flows: flows.count, leads: leads.count };
}
