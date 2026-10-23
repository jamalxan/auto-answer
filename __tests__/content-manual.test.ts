/**
 * ETAP 13 — manual publishing over Telegram (FR-N1…FR-N4): the notice with
 * media, copyable caption and buttons, sent once; the email fallback; the
 * "E'lon qildim" callback; binding the real media id afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  chats: [] as Array<{ id: string; chatId: string; integrationId: string }>,
  sendMessage: vi.fn<(...args: unknown[]) => Promise<{ message_id: number }>>(async () => ({ message_id: 1 })),
  sendPhoto: vi.fn<(...args: unknown[]) => Promise<{ message_id: number }>>(async () => ({ message_id: 2 })),
  sendVideo: vi.fn<(...args: unknown[]) => Promise<{ message_id: number }>>(async () => ({ message_id: 3 })),
  sendMediaGroup: vi.fn<(...args: unknown[]) => Promise<Array<{ message_id: number }>>>(async () => [{ message_id: 4 }]),
  alertWorkspace: vi.fn(async () => undefined),
  getUserMedia: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/telegram/api", () => ({
  isTelegramConfigured: () => true,
  sendMessage: mocks.sendMessage,
  sendPhoto: mocks.sendPhoto,
  sendVideo: mocks.sendVideo,
  sendMediaGroup: mocks.sendMediaGroup,
  esc: (v: string) => v,
}));
vi.mock("@/lib/telegram/notify", () => ({
  getWorkspaceChats: async () => mocks.chats,
  alertWorkspace: mocks.alertWorkspace,
  notifyWorkspaceChats: vi.fn(async () => 0),
}));
vi.mock("@/lib/meta/client", async (orig) => ({ ...(await orig<object>()), getUserMedia: mocks.getUserMedia }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => `dec:${v}` }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://cdn/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));
vi.mock("@/lib/content/queue", () => ({
  removePostJobs: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  schedulePrepare: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  scheduleRetry: vi.fn(async () => undefined),
  scheduleFirstComment: vi.fn(async () => undefined),
  enqueueMediaProcess: vi.fn(),
}));

import { bindManualPost, handleContentCallback, sendManualNotice } from "@/lib/content/manual";

const WS = "ws1";
const NOW = new Date("2026-10-24T14:00:00Z");

function seedMedia(id: string, kind: "IMAGE" | "VIDEO" = "IMAGE") {
  return db.seed("mediaAsset", { id, workspaceId: WS, kind, originalKey: `o/${id}`, preparedKey: `p/${id}`, thumbKey: `t/${id}`, mimeType: "image/jpeg", sizeBytes: 1, status: "READY" });
}
function seedPost(over: Record<string, unknown> = {}, media: Array<{ id: string; kind?: "IMAGE" | "VIDEO" }> = [{ id: "m1" }]) {
  const post = db.seed("scheduledPost", {
    id: "p1", workspaceId: WS, instagramAccountId: "acc1", type: "STORY", status: "SCHEDULED", caption: "Salom #tag @ali",
    autoPublish: false, manualReason: "STORY_STICKER", scheduledAt: NOW, attempts: 1, collaborators: [], ...over,
  });
  media.forEach((m, position) => {
    seedMedia(m.id, m.kind);
    db.seed("scheduledPostMedia", { postId: post.id, mediaId: m.id, position, userTags: [{ username: "ali" }] });
  });
  return post;
}

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) if (typeof m === "function") (m as ReturnType<typeof vi.fn>).mockClear();
  mocks.chats = [{ id: "tc1", chatId: "100", integrationId: "int1" }];
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("telegramUser", { tgUserId: "777", userId: "u1", workspaceId: WS });
});

describe("sendManualNotice", () => {
  it("moves to NEEDS_MANUAL and sends photo, caption and buttons to the chat", async () => {
    seedPost();
    const r = await sendManualNotice("p1", { now: () => NOW });
    expect(r.delivered).toBe("telegram");
    expect(db.rows("scheduledPost")[0].status).toBe("NEEDS_MANUAL");
    expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.sendPhoto.mock.calls[0][0]).toBe("100");
    expect(mocks.sendPhoto.mock.calls[0][1]).toBe("https://cdn/p/m1");
    // the caption goes as its own plain-text message so it can be copied
    const texts = mocks.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(texts).toContain("Salom #tag @ali");
    const withButtons = mocks.sendMessage.mock.calls.find((c) => (c[2] as { keyboard?: unknown })?.keyboard);
    expect(JSON.stringify(withButtons?.[2])).toContain("content:done:p1");
    expect(JSON.stringify(withButtons?.[2])).toContain("content:cancel:p1");
    expect(withButtons?.[1]).toMatch(/@ali/);
    expect(db.rows("publishAttempt").map((a) => [a.step, a.ok])).toEqual([["MANUAL_NOTICE", true]]);
  });

  it("sends a media group for several files and a video for one video", async () => {
    seedPost({ type: "CAROUSEL" }, [{ id: "m1" }, { id: "v1", kind: "VIDEO" }]);
    await sendManualNotice("p1", { now: () => NOW });
    expect(mocks.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(mocks.sendMediaGroup.mock.calls[0][1]).toEqual([{ type: "photo", media: "https://cdn/p/m1" }, { type: "video", media: "https://cdn/p/v1" }]);
    resetDb();
    db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
    db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "enc", tokenStatus: "ACTIVE" });
    seedPost({ type: "REEL" }, [{ id: "v1", kind: "VIDEO" }]);
    await sendManualNotice("p1", { now: () => NOW });
    expect(mocks.sendVideo).toHaveBeenCalledTimes(1);
  });

  it("without a Telegram chat it emails the owner once and never repeats (review focus 5)", async () => {
    mocks.chats = [];
    seedPost();
    const first = await sendManualNotice("p1", { now: () => NOW });
    expect(first.delivered).toBe("email");
    expect(db.rows("scheduledPost")[0].status).toBe("NEEDS_MANUAL");
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    const second = await sendManualNotice("p1", { now: () => NOW });
    expect(second.delivered).toBe("none");
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("also takes a FAILED post into manual mode", async () => {
    seedPost({ status: "FAILED", autoPublish: true, manualReason: null, lastErrorCode: "PUBLISH_MEDIA_INVALID" });
    await sendManualNotice("p1", { now: () => NOW });
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "NEEDS_MANUAL", manualReason: "API_REJECTED" });
  });
});

describe("handleContentCallback", () => {
  it("done → PUBLISHED_MANUAL for a linked Telegram user of the workspace", async () => {
    seedPost({ status: "NEEDS_MANUAL" });
    const toast = await handleContentCallback("content:done:p1", { tgUserId: "777", chatId: "100" });
    expect(db.rows("scheduledPost")[0].status).toBe("PUBLISHED_MANUAL");
    expect(toast).toMatch(/belgilandi/i);
  });

  it("cancel → CANCELED", async () => {
    seedPost({ status: "NEEDS_MANUAL" });
    await handleContentCallback("content:cancel:p1", { tgUserId: "777", chatId: "100" });
    expect(db.rows("scheduledPost")[0].status).toBe("CANCELED");
  });

  it("a stranger gets a refusal and nothing changes", async () => {
    seedPost({ status: "NEEDS_MANUAL" });
    const toast = await handleContentCallback("content:done:p1", { tgUserId: "999", chatId: "555" });
    expect(db.rows("scheduledPost")[0].status).toBe("NEEDS_MANUAL");
    expect(toast).toMatch(/ruxsat/i);
  });

  it("a chat linked to the workspace may confirm even without a personal link", async () => {
    db.seed("integration", { id: "int1", workspaceId: WS, type: "TELEGRAM", status: "ACTIVE" });
    db.seed("telegramChat", { integrationId: "int1", chatId: "100" });
    seedPost({ status: "NEEDS_MANUAL" });
    await handleContentCallback("content:done:p1", { tgUserId: "999", chatId: "100" });
    expect(db.rows("scheduledPost")[0].status).toBe("PUBLISHED_MANUAL");
  });
});

describe("bindManualPost", () => {
  it("binds the newest matching media published after the confirmation and activates the campaign", async () => {
    seedPost({ status: "PUBLISHED_MANUAL", publishedAt: NOW, type: "FEED_IMAGE" });
    db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "N", keywords: ["x"], dmMessage: "d", isActive: false, scheduledPostId: "p1", postId: null });
    mocks.getUserMedia.mockResolvedValue([
      { id: "old", media_type: "IMAGE", timestamp: new Date(NOW.getTime() - 60 * 60_000).toISOString() },
      { id: "new", media_type: "IMAGE", timestamp: new Date(NOW.getTime() + 2 * 60_000).toISOString(), permalink: "https://instagram.com/p/new" },
    ]);
    expect(await bindManualPost("p1")).toBe(true);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ igMediaId: "new", permalink: "https://instagram.com/p/new" });
    expect(db.rows("automation")[0]).toMatchObject({ postId: "new", isActive: true });
  });

  it("returns false when nothing new is there yet", async () => {
    seedPost({ status: "PUBLISHED_MANUAL", publishedAt: NOW, type: "FEED_IMAGE" });
    mocks.getUserMedia.mockResolvedValue([{ id: "old", media_type: "IMAGE", timestamp: new Date(NOW.getTime() - 60 * 60_000).toISOString() }]);
    expect(await bindManualPost("p1")).toBe(false);
    expect(db.rows("scheduledPost")[0].igMediaId).toBeNull();
  });
});
