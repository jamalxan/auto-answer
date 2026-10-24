/**
 * ETAP 13 Faza 2 — the Content Scheduler MCP tools (spec §9):
 * list_scheduled_posts, get_scheduled_post, get_publishing_quota and
 * create_post_draft (preview → confirm_action, DRAFT only, never scheduled),
 * tenant isolation, scopes and the CONTENT_SCHEDULER_DISABLED kill switch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  accountQuota: vi.fn(async (id: string) => ({ used: id === "acA" ? 7 : 1, total: 50, scheduledNext24h: 2, resetsAt: null, source: "cache" as const })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("@/lib/content/queue", () => ({
  schedulePrepare: mocks.schedulePrepare,
  schedulePublish: mocks.schedulePublish,
  scheduleManualNotify: mocks.scheduleManualNotify,
  removePostJobs: vi.fn(async () => undefined),
  enqueueMediaProcess: vi.fn(async () => undefined),
}));
vi.mock("@/lib/content/quota", () => ({ accountQuota: mocks.accountQuota, quotaWindowFull: () => false }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://signed.example/${key}?sig=SECRET`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));

import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { callTool, makeToken, rpc, seedWorld, WS_A, WS_B } from "./helpers/mcp-world";

let read: string;
let write: string;

function seedPost(id: string, workspaceId: string, accountId: string, over: Record<string, unknown> = {}) {
  db.seed("scheduledPost", { id, workspaceId, instagramAccountId: accountId, type: "FEED_IMAGE", status: "SCHEDULED", caption: `Caption ${id}`, collaborators: [], labels: [], timezone: "Asia/Tashkent", scheduledAt: new Date("2026-11-01T14:00:00Z"), attempts: 1, version: 1, shareToFeed: true, autoPublish: true, isAiGenerated: false, createdAt: new Date(), updatedAt: new Date(), ...over });
}

beforeEach(async () => {
  resetDb();
  vi.unstubAllEnvs();
  resetMcpRateLimitsForTests();
  for (const m of Object.values(mocks)) m.mockClear();
  seedWorld();
  db.seed("mediaAsset", { id: "mA", workspaceId: WS_A, kind: "IMAGE", originalKey: "o/mA", preparedKey: "p/mA", thumbKey: "t/mA", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
  db.seed("mediaAsset", { id: "mB", workspaceId: WS_B, kind: "IMAGE", originalKey: "o/mB", preparedKey: "p/mB", thumbKey: "t/mB", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
  seedPost("pA1", WS_A, "acA");
  seedPost("pA2", WS_A, "acA", { status: "DRAFT", scheduledAt: null });
  seedPost("pB1", WS_B, "acB");
  db.seed("scheduledPostMedia", { id: "spm1", postId: "pA1", mediaId: "mA", position: 0, altText: "Divan", userTags: [] });
  read = (await makeToken(WS_A, "READ")).raw;
  write = (await makeToken(WS_A, "WRITE")).raw;
});

describe("read tools", () => {
  it("list_scheduled_posts: only the token's workspace, filters by status, caption under untrusted", async () => {
    const all = await callTool(read, "list_scheduled_posts", {});
    expect(all.isError, all.text).toBe(false);
    expect(all.data.posts.map((p: { id: string }) => p.id).sort()).toEqual(["pA1", "pA2"]);
    expect(all.data.posts[0].untrusted.caption).toMatch(/Caption/);
    const drafts = await callTool(read, "list_scheduled_posts", { status: "DRAFT" });
    expect(drafts.data.posts.map((p: { id: string }) => p.id)).toEqual(["pA2"]);
    const window = await callTool(read, "list_scheduled_posts", { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" });
    expect(window.data.posts.map((p: { id: string }) => p.id)).toEqual(["pA1"]);
  });

  it("get_scheduled_post: details without signed media URLs; a foreign id reads as not found", async () => {
    const own = await callTool(read, "get_scheduled_post", { postId: "pA1" });
    expect(own.isError, own.text).toBe(false);
    expect(own.data).toMatchObject({ id: "pA1", status: "SCHEDULED", account: "@mebel_a", media: [{ mediaId: "mA", kind: "IMAGE" }] });
    expect(own.data.untrusted.altTexts).toEqual(["Divan"]);
    expect(own.text).not.toMatch(/signed\.example|SECRET/);
    const foreign = await callTool(read, "get_scheduled_post", { postId: "pB1" });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toBe("Post topilmadi");
  });

  it("get_publishing_quota: per account of the workspace, a foreign account is not found", async () => {
    const q = await callTool(read, "get_publishing_quota", {});
    expect(q.data.accounts).toEqual([expect.objectContaining({ instagramAccountId: "acA", used: 7, total: 50, scheduledNext24h: 2, remaining: 41 })]);
    const foreign = await callTool(read, "get_publishing_quota", { accountId: "acB" });
    expect(foreign.isError).toBe(true);
    expect(mocks.accountQuota).not.toHaveBeenCalledWith("acB");
  });
});

describe("create_post_draft", () => {
  const input = { instagramAccountId: "acA", type: "FEED_IMAGE", caption: "Yangi divan! Narx uchun \"narx\" deb yozing", mediaIds: ["mA"], altTexts: ["Divan"] };

  it("previews first (nothing created), then confirm_action creates a DRAFT that is never scheduled", async () => {
    const before = db.rows("scheduledPost").length;
    const proposal = await callTool(write, "create_post_draft", input);
    expect(proposal.isError, proposal.text).toBe(false);
    expect(proposal.data.status).toBe("PREVIEW");
    expect(proposal.data.preview.details).toMatchObject({ status: "DRAFT", willSchedule: false, willPublish: false });
    expect(db.rows("scheduledPost")).toHaveLength(before);

    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    expect(done.isError, done.text).toBe(false);
    expect(done.data.result).toMatchObject({ status: "DRAFT", scheduled: false, published: false });
    const post = db.rows("scheduledPost").find((p) => p.id === done.data.result.postId)!;
    expect(post).toMatchObject({ workspaceId: WS_A, instagramAccountId: "acA", status: "DRAFT", caption: input.caption });
    expect(post.scheduledAt ?? null).toBeNull();
    expect(post.labels).toContain("mcp");
    expect(db.rows("scheduledPostMedia").filter((m) => m.postId === post.id)).toEqual([expect.objectContaining({ mediaId: "mA", altText: "Divan" })]);
    expect(mocks.schedulePrepare).not.toHaveBeenCalled();
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
    expect(mocks.scheduleManualNotify).not.toHaveBeenCalled();
  });

  it("has no way to schedule or publish: scheduledAt / status / autoPublish are refused by the schema", async () => {
    for (const extra of [{ scheduledAt: "2026-11-01T14:00:00Z" }, { status: "SCHEDULED" }, { publish: true }, { autoPublish: true }]) {
      const r = await callTool(write, "create_post_draft", { ...input, ...extra });
      expect(r.isError).toBe(true);
    }
    expect(db.rows("mcpAction")).toHaveLength(0);
    const list = await rpc(write, "tools/list");
    const tool = list.json.result.tools.find((t: { name: string }) => t.name === "create_post_draft");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/scheduledAt|autoPublish|"status"/);
  });

  it("tenant isolation: another workspace's account or media is not found and nothing is proposed", async () => {
    expect((await callTool(write, "create_post_draft", { ...input, instagramAccountId: "acB" })).text).toBe("Instagram akkaunt topilmadi");
    expect((await callTool(write, "create_post_draft", { ...input, mediaIds: ["mB"] })).text).toBe("Media topilmadi");
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("an incomplete draft is allowed; the preview lists what blocks scheduling", async () => {
    const proposal = await callTool(write, "create_post_draft", { instagramAccountId: "acA", type: "CAROUSEL", mediaIds: ["mA"] });
    expect(proposal.isError, proposal.text).toBe(false);
    expect(proposal.data.preview.warnings.join(" ")).toMatch(/Karuselda 2 dan/);
  });

  it("a READ token cannot propose", async () => {
    const r = await callTool(read, "create_post_draft", input);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/faqat o'qish/);
  });
});

describe("kill switch CONTENT_SCHEDULER_DISABLED", () => {
  it("hides the four tools from tools/list and refuses calls", async () => {
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    const list = await rpc(write, "tools/list");
    const names: string[] = list.json.result.tools.map((t: { name: string }) => t.name);
    for (const n of ["list_scheduled_posts", "get_scheduled_post", "create_post_draft", "get_publishing_quota"]) expect(names).not.toContain(n);
    expect(names).toContain("list_campaigns");
    const call = await callTool(read, "list_scheduled_posts", {});
    expect(call.isError).toBe(true);
    expect(call.rpcError?.message).toMatch(/Noma'lum asbob/);
  });

  it("a draft proposed before the switch was flipped cannot be confirmed after", async () => {
    const proposal = await callTool(write, "create_post_draft", { instagramAccountId: "acA", type: "FEED_IMAGE", mediaIds: ["mA"] });
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    const before = db.rows("scheduledPost").length;
    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    expect(done.isError).toBe(true);
    expect(db.rows("scheduledPost")).toHaveLength(before);
  });
});
