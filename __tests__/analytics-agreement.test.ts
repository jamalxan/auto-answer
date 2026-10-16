/**
 * B-11 / B-34 J test: the Panel (live DmLog / Lead tables), the analytics
 * rollups (dev Analytics) and the undelivered summary (Diagnostics) read the
 * same data, including production (legacy Automation) activity, and the
 * initial backfill is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { readAnalytics } from "@/lib/analytics/read";
import { ensureInitialBackfill, resetInitialBackfillForTests } from "@/lib/analytics/rollup";
import { getLeadCards } from "@/lib/dashboard/stats";
import { loadDeliverySummary } from "@/lib/leads/undelivered";

const WS = "ws_1";
const NOW = new Date("2026-10-15T10:00:00Z");

beforeEach(() => {
  resetDb();
  resetInitialBackfillForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.seed("instagramAccount", { id: "ig_1", workspaceId: WS, username: "acme", instagramId: "IG1" });
  db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "ig_1", name: "Salom", isActive: true, keywords: ["salom"] });
  // Production (legacy) activity: one sent DM with dmSentAt, one older row without it, one skipped.
  db.seed("dmLog", { id: "d1", workspaceId: WS, automationId: "au1", instagramAccountId: "ig_1", status: "SENT", dmSentAt: new Date("2026-10-14T08:00:00Z"), createdAt: new Date("2026-10-14T07:59:00Z") });
  db.seed("dmLog", { id: "d2", workspaceId: WS, automationId: "au1", instagramAccountId: "ig_1", status: "SENT", dmSentAt: null, createdAt: new Date("2026-10-13T08:00:00Z") });
  db.seed("dmLog", { id: "d3", workspaceId: WS, automationId: "au1", instagramAccountId: "ig_1", status: "SKIPPED_DEDUP", createdAt: new Date("2026-10-13T09:00:00Z") });
  for (const [id, isTest] of [["l1", false], ["l2", false], ["l3", true]] as const) {
    db.seed("lead", { id, workspaceId: WS, instagramAccountId: "ig_1", isTest, createdAt: new Date("2026-10-14T09:00:00Z") });
  }
});
afterEach(() => vi.useRealTimers());

describe("one set of numbers across screens", () => {
  it("Panel, dev Analytics and Leads agree on DM and lead counts; backfill is idempotent", async () => {
    expect(await ensureInitialBackfill(WS, NOW)).toBeGreaterThan(0);
    const rowsAfterFirst = db.rows("analyticsDaily").length;
    resetInitialBackfillForTests();
    expect(await ensureInitialBackfill(WS, NOW)).toBe(0); // rollups exist: nothing to redo
    expect(db.rows("analyticsDaily")).toHaveLength(rowsAfterFirst);

    const result = await readAnalytics(WS, { tab: "campaign", preset: "30d", compare: "none", mode: "period" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metric = (key: string) => result.data.metrics[key]?.value ?? 0;

    const panelSent = db.rows("dmLog").filter((r) => r.status === "SENT").length;
    expect(panelSent).toBe(2);
    expect(metric("campaign.sent")).toBe(panelSent);

    const cards = await getLeadCards(WS);
    const realLeads = db.rows("lead").filter((l) => !l.isTest).length;
    expect(cards.leads30).toBe(realLeads);

    const sales = await readAnalytics(WS, { tab: "sales", preset: "30d", compare: "none", mode: "period" }, NOW);
    if (!sales.ok) throw new Error("sales read failed");
    expect(sales.data.metrics["sales.leads"]?.value).toBe(realLeads);
  });

  it("Diagnostics and the dashboard card use the same undelivered number", async () => {
    db.seed("integration", { id: "i1", workspaceId: WS, type: "AMOCRM", name: "amoCRM", status: "BROKEN" });
    db.seed("leadDelivery", { id: "ld1", leadId: "l1", integrationId: "i1", status: "PENDING", attempts: 0, updatedAt: new Date() });
    const summary = await loadDeliverySummary(WS);
    const cards = await getLeadCards(WS);
    expect(summary.undeliveredLeads).toBe(1);
    expect(cards.undelivered).toBe(summary.undeliveredLeads);
  });
});
