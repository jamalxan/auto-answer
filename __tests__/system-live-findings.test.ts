/**
 * Regressions from the live system review (2026-10-21):
 *  - the AI health check judged developer-tool calls (sandbox, AI Flow Builder,
 *    migration, shadow) as if customers received them ("60 % errors");
 *  - the opening-DM read fallback had no time bound, so reading ANY later
 *    message re-sent an old campaign's reveal link;
 *  - pause_campaign on an already paused campaign queued a no-op action.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import { isToolingLlmKind, loadLlmStatsByAudience } from "../lib/assistant/llm/stats";
import { buildAiCheck } from "../lib/foundation/diagnostics";
import { OPENING_DM_READ_WINDOW_MS, openingDmReadWhere } from "../lib/campaigns/read-fallback";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { ALREADY_PAUSED } from "../lib/mcp/service";
import { callTool, makeToken, seedWorld, WS_A } from "./helpers/mcp-world";

const NOW = new Date("2026-10-21T10:00:00Z");

describe("AI health check: customer-facing calls only", () => {
  beforeEach(() => resetDb());

  it("tooling kinds are recognised; live reply kinds are not", () => {
    for (const kind of ["javobai_sandbox", "javobai_flowbuilder", "javobai_migration", "javobai_shadow"]) expect(isToolingLlmKind(kind)).toBe(true);
    for (const kind of ["javobai_reply", "javobai_summary", "javobai_vision", "javobai_stt", "reply", null]) expect(isToolingLlmKind(kind)).toBe(false);
  });

  it("splits the window by audience", async () => {
    const row = (kind: string, ok: boolean) => db.seed("llmUsage", { workspaceId: WS_A, kind, ok, latencyMs: 100, createdAt: new Date() });
    // The live shape: 10 calls, 6 failed — 5 of the failures in developer tools.
    for (let i = 0; i < 4; i++) row("javobai_sandbox", i < 3 ? false : true);
    row("javobai_sandbox", true);
    row("javobai_sandbox", true);
    row("javobai_sandbox", true);
    row("javobai_flowbuilder", false);
    row("javobai_flowbuilder", false);
    row("reply", false);
    const stats = await loadLlmStatsByAudience(WS_A, new Date(Date.now() - 7 * 86_400_000));
    expect(stats.customer).toMatchObject({ calls: 1, failures: 1 });
    expect(stats.tooling).toMatchObject({ calls: 9, failures: 5 });
  });

  it("developer-tool failures alone never raise the customer warning, and are still shown", () => {
    const item = buildAiCheck(
      { configured: true, model: "m", templateOnlyUntil: null, llm: { calls: 0, failures: 0, windowDays: 7, tooling: { calls: 9, failures: 5 } } },
      NOW
    );
    expect(item.status).toBe("ok");
    expect(item.value).toContain("developer vositalari: 5/9 xato");
  });

  it("customer-facing failures above the rate still warn", () => {
    const item = buildAiCheck({ configured: true, model: "m", templateOnlyUntil: null, llm: { calls: 20, failures: 5, windowDays: 7, tooling: { calls: 0, failures: 0 } } }, NOW);
    expect(item.status).toBe("warning");
  });
});

describe("opening-DM read fallback", () => {
  it("only looks at opening DMs of the last 24 h, never at reveal rows", () => {
    const where = openingDmReadWhere("ig1", "u1", NOW) as Record<string, unknown>;
    expect(where).toMatchObject({ commenterId: "u1", status: "SENT" });
    expect((where.dmSentAt as { gte: Date }).gte.getTime()).toBe(NOW.getTime() - OPENING_DM_READ_WINDOW_MS);
    expect(where.NOT).toEqual({ commentId: { startsWith: "reveal:" } });
    expect(where.automation).toMatchObject({ isActive: true, openingDmEnabled: true, instagramAccount: { instagramId: "ig1" } });
  });
});

describe("pause_campaign", () => {
  beforeEach(() => {
    resetDb();
    resetMcpRateLimitsForTests();
    seedWorld();
  });

  it("an already paused campaign is refused instead of queuing a no-op action", async () => {
    db.seed("triggerCampaign", { id: "cmpP", workspaceId: WS_A, instagramAccountId: "acA", name: "Pauza", triggerType: "COMMENT", keywords: ["x"], responseMessage: "y", active: false, kind: "CAMPAIGN" });
    const write = (await makeToken(WS_A, "WRITE")).raw;
    const result = await callTool(write, "pause_campaign", { campaignId: "cmpP" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(ALREADY_PAUSED);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("an active campaign still gets a preview", async () => {
    const write = (await makeToken(WS_A, "WRITE")).raw;
    const result = await callTool(write, "pause_campaign", { campaignId: "cmpA" });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.status).toBe("PREVIEW");
  });
});
