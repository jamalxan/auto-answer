/**
 * ETAP 10 - cohort funnel, computed live from CrmContact (not from rollups).
 *
 * Cohort = contacts whose first interaction falls in the range. Each stage is
 * a subset of the previous one, so drop-offs are real conversions of the same
 * people: comment -> DM sent -> replied -> deal (lead) -> hot -> sale (WON).
 */

import { prisma } from "@/lib/db/client";
import { dayWindow } from "./time";

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  compare: number | null;
  deltaPct: number | null;
  /** Share of the first stage, percent. */
  pctOfFirst: number | null;
  /** Share lost since the previous stage, percent; null for the first or when it grew. */
  dropOffPct: number | null;
}

export const COHORT_CONTACT_LIMIT = 20_000;
const CHUNK = 5_000;

interface CohortContact {
  id: string;
  source: string;
  status: string;
  temperature: string;
  lastOutboundAt: Date | null;
  lastInboundAt: Date | null;
}

export function buildCohortStages(contacts: CohortContact[], dealsByContact: Map<string, { won: boolean }[]>): FunnelStage[] {
  const hasDeal = (c: CohortContact) => (dealsByContact.get(c.id)?.length ?? 0) > 0;
  const hasWon = (c: CohortContact) => (dealsByContact.get(c.id) ?? []).some((d) => d.won);
  const isHot = (c: CohortContact) => c.temperature === "HOT" || c.temperature === "CUSTOMER" || c.status === "CUSTOMER" || hasWon(c);

  const steps: Array<{ key: string; label: string; test: (c: CohortContact) => boolean }> = [
    { key: "comments", label: "Komment orqali kelganlar", test: (c) => c.source === "COMMENT" },
    { key: "dms", label: "DM yuborildi", test: (c) => c.lastOutboundAt !== null },
    { key: "replies", label: "Javob berdi", test: (c) => c.lastInboundAt !== null },
    { key: "leads", label: "Lid (bitim)", test: hasDeal },
    { key: "hot", label: "Hot", test: isHot },
    { key: "sales", label: "Sotuv (Won)", test: hasWon },
  ];

  let pool = contacts;
  const counts: number[] = [];
  for (const step of steps) {
    pool = pool.filter(step.test);
    counts.push(pool.length);
  }
  return steps.map((step, i) => {
    const value = counts[i];
    const before = i > 0 ? counts[i - 1] : null;
    return {
      key: step.key,
      label: step.label,
      value,
      compare: null,
      deltaPct: null,
      pctOfFirst: counts[0] > 0 ? Math.round((value / counts[0]) * 1000) / 10 : null,
      dropOffPct: before !== null && before > 0 ? Math.round(((before - value) / before) * 1000) / 10 : null,
    };
  });
}

export async function computeCohortFunnel(
  workspaceId: string,
  options: { from: string; to: string; accountId?: string | null }
): Promise<{ stages: FunnelStage[]; truncated: boolean; note: string; total: number }> {
  const start = dayWindow(options.from).start;
  const end = dayWindow(options.to).end;
  const rows = (await prisma.crmContact.findMany({
    where: {
      workspaceId,
      mergedIntoId: null,
      firstInteractionAt: { gte: start, lt: end },
      ...(options.accountId ? { instagramAccountId: options.accountId } : {}),
    },
    take: COHORT_CONTACT_LIMIT + 1,
  })) as unknown as CohortContact[];
  const truncated = rows.length > COHORT_CONTACT_LIMIT;
  const contacts = truncated ? rows.slice(0, COHORT_CONTACT_LIMIT) : rows;

  const dealsByContact = new Map<string, { won: boolean }[]>();
  for (let i = 0; i < contacts.length; i += CHUNK) {
    const ids = contacts.slice(i, i + CHUNK).map((c) => c.id);
    const deals = (await prisma.crmDeal.findMany({ where: { workspaceId, contactId: { in: ids } } })) as unknown as Array<{ contactId: string; wonAt: Date | null }>;
    for (const d of deals) {
      const list = dealsByContact.get(d.contactId) ?? [];
      list.push({ won: d.wonAt !== null && d.wonAt !== undefined });
      dealsByContact.set(d.contactId, list);
    }
  }

  return {
    stages: buildCohortStages(contacts, dealsByContact),
    truncated,
    total: contacts.length,
    note: `Davr ichida birinchi marta bog'langan ${contacts.length} kontakt kuzatildi${truncated ? ` (birinchi ${COHORT_CONTACT_LIMIT} tasi)` : ""}`,
  };
}
