/**
 * Regressions found by running the MCP tools against the live test workspace
 * (2026-10-21): a live legacy campaign invisible to list_campaigns, a funnel
 * tab with no numbers, a knowledge search that "found" every query, an empty
 * lead list with no reason, and template fallbacks skipped by the auditor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ loadKpi: vi.fn(), runDiagnostics: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("@/lib/analytics/kpi", () => ({ loadKpi: mocks.loadKpi }));
vi.mock("@/lib/foundation/diagnostics", () => ({ runDiagnostics: mocks.runDiagnostics }));

import { findPhoneNumbers, findUrls } from "../lib/flows/audit";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { CRM_OFF_NOTE, KB_NO_MATCH } from "../lib/mcp/service";
import { callTool, makeToken, seedWorld, WS_A, WS_B } from "./helpers/mcp-world";

let read: string;

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  seedWorld();
  read = (await makeToken(WS_A, "READ")).raw;
});

const legacy = (id: string, workspaceId: string, instagramAccountId: string, isActive: boolean) =>
  db.seed("automation", {
    id,
    workspaceId,
    instagramAccountId,
    name: `Legacy ${id}`,
    keywords: ["salom"],
    matchAnyWord: false,
    matchAnyPost: true,
    postId: null,
    dmMessage: "Salom!",
    isActive,
    createdAt: new Date(),
  });

describe("list_campaigns shows the legacy production campaigns", () => {
  it("an active legacy campaign is listed read-only, filtered by status, never another workspace's", async () => {
    legacy("au1", WS_A, "acA", true);
    legacy("au2", WS_A, "acA", false);
    legacy("auB", WS_B, "acB", true);

    const all = await callTool(read, "list_campaigns");
    expect(all.isError, all.text).toBe(false);
    const ids = all.data.legacyCampaigns.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual(["au1", "au2"]);
    expect(all.data.legacyCampaigns.find((c: { id: string }) => c.id === "au1")).toMatchObject({ status: "ACTIVE", readOnly: true, keywords: ["salom"] });

    const active = await callTool(read, "list_campaigns", { status: "active" });
    expect(active.data.legacyCampaigns.map((c: { id: string }) => c.id)).toEqual(["au1"]);
    const paused = await callTool(read, "list_campaigns", { status: "paused" });
    expect(paused.data.legacyCampaigns.map((c: { id: string }) => c.id)).toEqual(["au2"]);
  });

  it("no legacy rows -> an empty list, campaigns unchanged", async () => {
    const { data } = await callTool(read, "list_campaigns");
    expect(data.legacyCampaigns).toEqual([]);
    expect(data.campaigns.map((c: { id: string }) => c.id)).toContain("cmpA");
  });
});

describe("get_analytics_summary funnel", () => {
  it("returns the funnel stages as metrics instead of an empty list", async () => {
    const { data, isError, text } = await callTool(read, "get_analytics_summary", { tab: "funnel", period: "30d" });
    expect(isError, text).toBe(false);
    expect(data.metrics.length).toBeGreaterThan(0);
    expect(data.metrics[0]).toMatchObject({ key: "funnel.comments", label: "Kommentlar", value: 0 });
    expect(data.metrics.map((m: { key: string }) => m.key)).toContain("funnel.sales");
    expect(data.funnelNote).toBeTruthy();
  });
});

describe("search_knowledge_base", () => {
  beforeEach(() => {
    db.seed("assistantProfile", { id: "pr1", workspaceId: WS_A, instagramAccountId: null, companyName: "Mebel A", description: "Divan va stol sotamiz", enabled: true });
    db.seed("assistantProduct", { id: "p1", profileId: "pr1", name: "Divan Milan", price: 3500000, currency: "UZS" });
    db.seed("assistantProduct", { id: "p2", profileId: "pr1", name: "Shkaf Oslo", price: 2100000, currency: "UZS" });
  });

  it("an unrelated query finds nothing (the profile is not padded in)", async () => {
    const miss = await callTool(read, "search_knowledge_base", { query: "qwertyzxcv" });
    expect(miss.isError, miss.text).toBe(false);
    expect(miss.data).toMatchObject({ found: false, note: KB_NO_MATCH });
    expect(miss.data.untrusted.lines).toEqual([]);
  });

  it("returns only the matching lines", async () => {
    const hit = await callTool(read, "search_knowledge_base", { query: "shkaf" });
    expect(hit.data.found).toBe(true);
    const text = JSON.stringify(hit.data.untrusted.lines);
    expect(text).toMatch(/Shkaf Oslo/);
    expect(text).not.toMatch(/Divan Milan/);
  });
});

describe("list_leads with the CRM module off", () => {
  it("an empty list says why", async () => {
    db.rows("crmContact").splice(0);
    const prev = process.env.CRM_ENABLED;
    delete process.env.CRM_ENABLED;
    try {
      const { data } = await callTool(read, "list_leads");
      expect(data.total).toBe(0);
      expect(data.note).toBe(CRM_OFF_NOTE);
    } finally {
      if (prev !== undefined) process.env.CRM_ENABLED = prev;
    }
  });

  it("a non-empty list carries no note", async () => {
    const { data } = await callTool(read, "list_leads");
    expect(data.total).toBeGreaterThan(0);
    expect(data.note).toBeUndefined();
  });
});

describe("template fallbacks are checked like message text", () => {
  it("a URL or phone in a {{key|fallback}} is found; a bare {{key}} is not", () => {
    expect(findUrls("Narxlar: {{vars.price_link|https://t.me/promtchi_bot}}")).toEqual(["https://t.me/promtchi_bot"]);
    expect(findUrls("www.site.uz va {{vars.catalog_url}}")).toEqual(["www.site.uz"]);
    expect(findPhoneNumbers("Qo'ng'iroq: {{vars.tel|+998 90 123 45 67}}")).toHaveLength(1);
    expect(findPhoneNumbers("Salom {{name|do'stim}}")).toEqual([]);
  });
});
