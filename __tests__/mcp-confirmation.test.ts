/**
 * ETAP 12 — the propose -> confirm layer: a preview has no side effect, a
 * confirm runs exactly once (also under Promise.all), a wrong code / expired /
 * rejected / other token's action never runs, failures are recorded, and no
 * raw token, token hash or confirm-code hash appears in any answer or log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { CONFIRM_TTL_MS, MAX_PENDING_ACTIONS } from "../lib/mcp/config";
import { hashCode, listActions, normalizeCode } from "../lib/mcp/confirm";
import { callTool, makeToken, rpc, seedWorld, WS_A } from "./helpers/mcp-world";

let write: string;
let writeId: string;

const CAMPAIGN = { name: "Narx kampaniya", instagramAccountId: "acA", keywords: ["narx", "цена"], dmMessage: "Narxlar: 100 000 so'm", publicReplies: ["Direct'ga yubordik!"] };

const campaigns = () => db.rows("triggerCampaign").filter((c) => c.workspaceId === WS_A);
const actionRow = (id: string) => db.rows("mcpAction").find((r) => r.id === id)!;

async function propose(args: Record<string, unknown> = CAMPAIGN, tool = "create_keyword_campaign", token = write) {
  const result = await callTool(token, tool, args);
  expect(result.isError).toBe(false);
  return result.data as { status: string; actionId: string; confirmCode: string; expiresAt: string; preview: { summary: string; details: Record<string, unknown>; warnings: string[] } };
}

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  seedWorld();
  const token = await makeToken(WS_A, "WRITE", "writer");
  write = token.raw;
  writeId = token.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preview", () => {
  it("returns PREVIEW with actionId, code, expiry and changes nothing", async () => {
    const before = db.log.length;
    const beforeCampaigns = campaigns().length;
    const p = await propose();
    expect(p.status).toBe("PREVIEW");
    expect(p.actionId).toBeTruthy();
    expect(p.confirmCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(p.expiresAt).getTime() - Date.now()).toBeGreaterThan(CONFIRM_TTL_MS - 5000);
    expect(new Date(p.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(CONFIRM_TTL_MS + 1000);
    expect(p.preview.summary).toMatch(/Narx kampaniya/);
    expect(p.preview.details.keywords).toEqual(["narx", "цена"]);

    expect(campaigns()).toHaveLength(beforeCampaigns);
    expect(db.rows("triggerReplyVariant")).toHaveLength(0);
    const writes = db.log.slice(before).filter((l) => l.model !== "mcpAction" && l.model !== "mcpToken");
    expect(writes).toEqual([]);

    const row = actionRow(p.actionId);
    expect(row.status).toBe("PROPOSED");
    expect(row.tool).toBe("create_keyword_campaign");
    expect(row.tokenId).toBe(writeId);
    expect(row.workspaceId).toBe(WS_A);
  });

  it("stores only a hash of the code, salted with the action id", async () => {
    const p = await propose();
    const row = actionRow(p.actionId);
    expect(row.confirmCodeHash).toBe(hashCode(p.actionId, p.confirmCode));
    expect(JSON.stringify(row)).not.toContain(normalizeCode(p.confirmCode));
    expect(row.confirmCodeHash).not.toBe(hashCode("other-id", p.confirmCode));
  });

  it("invalid input never produces a proposal", async () => {
    const bad = await callTool(write, "create_keyword_campaign", { ...CAMPAIGN, keywords: [] });
    expect(bad.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("caps the unsettled proposals of one token", async () => {
    for (let i = 0; i < MAX_PENDING_ACTIONS; i++) await propose({ campaignId: "cmpA" }, "pause_campaign");
    const over = await callTool(write, "pause_campaign", { campaignId: "cmpA" });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/Tasdiq kutayotgan/);
  });
});

describe("confirm", () => {
  it("executes once and records the result", async () => {
    const p = await propose();
    const done = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe("EXECUTED");
    expect(done.data.result.status).toBe("PAUSED");
    const created = campaigns().filter((c) => c.name === "Narx kampaniya");
    expect(created).toHaveLength(1);
    expect(created[0].active).toBe(false);

    const row = actionRow(p.actionId);
    expect(row.status).toBe("EXECUTED");
    expect(row.confirmCodeHash).toBeNull();
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect((row.result as { campaignId: string }).campaignId).toBe(created[0].id);
    // the platform's operational log gets a line too
    expect(db.rows("operationalEvent").some((e) => /create_keyword_campaign/.test(String(e.message)))).toBe(true);
  });

  it("accepts the code in lower case and without the dash", async () => {
    const p = await propose();
    const done = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode.replace("-", "").toLowerCase() });
    expect(done.data.status).toBe("EXECUTED");
  });

  it("a second confirm of the same action fails and does not execute again", async () => {
    const p = await propose();
    await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    const again = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/allaqachon/);
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(1);
  });

  it("concurrent confirms (Promise.all) execute exactly once", async () => {
    const p = await propose();
    const results = await Promise.all(Array.from({ length: 6 }, () => callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.filter((r) => r.isError)).toHaveLength(5);
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(1);
    expect(db.rows("triggerReplyVariant").filter((v) => v.kind === "PUBLIC")).toHaveLength(1);
    expect(actionRow(p.actionId).status).toBe("EXECUTED");
  });

  it("a wrong code is refused, changes nothing and does not burn the action", async () => {
    const p = await propose();
    const wrong = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: "AAAA-AAAA" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/kodi noto'g'ri/);
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(0);
    expect(actionRow(p.actionId).status).toBe("PROPOSED");
    const right = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(right.data.status).toBe("EXECUTED");
  });

  it("a code of another action does not work", async () => {
    const one = await propose();
    const two = await propose({ ...CAMPAIGN, name: "Ikkinchi" });
    const crossed = await callTool(write, "confirm_action", { actionId: one.actionId, confirmCode: two.confirmCode });
    expect(crossed.isError).toBe(true);
    expect(campaigns().filter((c) => c.name === "Narx kampaniya" || c.name === "Ikkinchi")).toHaveLength(0);
  });

  it("an expired proposal cannot be confirmed and is marked EXPIRED", async () => {
    const p = await propose();
    actionRow(p.actionId).expiresAt = new Date(Date.now() - 1000);
    const late = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/muddati tugagan/);
    expect(actionRow(p.actionId).status).toBe("EXPIRED");
    expect(actionRow(p.actionId).confirmCodeHash).toBeNull();
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(0);
    // and the developer log shows it as expired
    expect((await listActions(WS_A)).find((a) => a.id === p.actionId)!.status).toBe("EXPIRED");
  });

  it("another token of the same workspace cannot confirm or reject it", async () => {
    const other = await makeToken(WS_A, "WRITE", "other");
    const p = await propose();
    const confirm = await callTool(other.raw, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toMatch(/topilmadi/);
    expect((await callTool(other.raw, "reject_action", { actionId: p.actionId })).isError).toBe(true);
    expect(actionRow(p.actionId).status).toBe("PROPOSED");
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(0);
  });

  it("an unknown action id is not found", async () => {
    const result = await callTool(write, "confirm_action", { actionId: "nope", confirmCode: "AAAA-AAAA" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/topilmadi/);
  });
});

describe("reject", () => {
  it("a rejected action can never be confirmed", async () => {
    const p = await propose();
    const rejected = await callTool(write, "reject_action", { actionId: p.actionId });
    expect(rejected.data.status).toBe("REJECTED");
    expect(actionRow(p.actionId).confirmCodeHash).toBeNull();
    const confirm = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(confirm.isError).toBe(true);
    expect(campaigns().filter((c) => c.name === "Narx kampaniya")).toHaveLength(0);
    expect((await callTool(write, "reject_action", { actionId: p.actionId })).isError).toBe(true);
  });

  it("an executed action cannot be rejected afterwards", async () => {
    const p = await propose();
    await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect((await callTool(write, "reject_action", { actionId: p.actionId })).isError).toBe(true);
    expect(actionRow(p.actionId).status).toBe("EXECUTED");
  });
});

describe("failures", () => {
  it("an execution that fails is recorded as FAILED, safe message, no retry with the same code", async () => {
    const p = await propose({ campaignId: "cmpA" }, "pause_campaign");
    // the campaign disappears between the preview and the confirmation
    db.tables.triggerCampaign = db.rows("triggerCampaign").filter((c) => c.id !== "cmpA");
    const done = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(done.isError).toBe(true);
    expect(done.text).toMatch(/topilmadi/);
    const row = actionRow(p.actionId);
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/topilmadi/);
    expect((await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode })).isError).toBe(true);
  });

  it("an unexpected error is not echoed to the client", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await propose({ campaignId: "cmpA" }, "pause_campaign");
    // Force the executor to throw something with internals in its message.
    const comment = await import("../lib/triggers/comment-service");
    vi.spyOn(comment, "setCommentCampaignActive").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    const done = await callTool(write, "confirm_action", { actionId: p.actionId, confirmCode: p.confirmCode });
    expect(done.isError).toBe(true);
    expect(done.text).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(actionRow(p.actionId).status).toBe("FAILED");
    expect(String(actionRow(p.actionId).error)).not.toMatch(/hunter2/);
  });
});

describe("no secret in answers or logs", () => {
  it("raw token, token hash and confirm-code hash never appear in any response, log row or console line", async () => {
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(" ")));
    }
    const responses: string[] = [];
    const collect = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await callTool(write, name, args);
      responses.push(r.text);
      return r;
    };
    const list = await rpc(write, "tools/list");
    responses.push(list.text);
    await collect("list_campaigns");
    await collect("get_campaign", { campaignId: "cmpA" });
    await collect("list_leads");
    const p = await collect("create_keyword_campaign", CAMPAIGN);
    await collect("confirm_action", { actionId: p.data.actionId, confirmCode: p.data.confirmCode });
    await collect("pause_campaign", { campaignId: "nope" });
    const actions = JSON.stringify(await listActions(WS_A));

    const tokenRow = db.rows("mcpToken").find((r) => r.id === writeId)!;
    const secrets = [write, String(tokenRow.tokenHash), String(actionRow(p.data.actionId).confirmCodeHash ?? ""), hashCode(p.data.actionId, p.data.confirmCode)].filter(Boolean);
    const haystack = [...responses, actions, ...consoleLines].join("\n");
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    expect(actions).not.toMatch(/confirmCodeHash|tokenHash/);
    // the stored proposal input stays internal: the developer log carries preview + result only
    expect(actions).not.toContain('"input"');
  });
});
