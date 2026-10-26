import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("TELEGRAM_BOT_TOKEN", "777000:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN");
vi.stubEnv("TELEGRAM_BOT_USERNAME", "SocialAutoBot");

const redisStore = vi.hoisted(() => new Map<string, string>());
const notify = vi.hoisted(() => vi.fn(async (_workspaceId: string, _text: string, _options?: unknown) => 1));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === "NX" && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    get: async (key: string) => redisStore.get(key) ?? null,
    del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? 0) + 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
  }),
}));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));
vi.mock("../lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://media.example/${key}` }),
}));
vi.mock("../lib/telegram/api", async (original) => ({
  ...(await original<typeof import("../lib/telegram/api")>()),
  sendMessage: vi.fn(async () => ({ message_id: 900 })),
  sendPhoto: vi.fn(async () => ({ message_id: 901 })),
  sendVideo: vi.fn(async () => ({ message_id: 902 })),
  sendMediaGroup: vi.fn(async (_chat: unknown, media: unknown[]) => media.map((_, i) => ({ message_id: 910 + i }))),
  getChat: vi.fn(async (chatId: string | number) => ({ id: Number(chatId), type: "channel", title: "Do'kon", username: "dokon", linked_chat_id: -1002 })),
  getChatMember: vi.fn(async () => ({ status: "administrator" })),
  leaveChat: vi.fn(async () => true),
  deleteMessage: vi.fn(async () => true),
  editMessageCaption: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => ({})),
}));

import { deleteMessage, getChat, getChatMember, leaveChat, sendMediaGroup, sendMessage, sendPhoto, TelegramApiError } from "../lib/telegram/api";
import { handleTelegramUpdate, type TgUpdate } from "../lib/telegram/bot";
import {
  handleBusinessConnection,
  handleChannelMembership,
  replyToChannelMessage,
  routeChannelMessage,
  type TgMyChatMember,
} from "../lib/telegram/channel";
import { handleLadderCallback, handleLadderText } from "../lib/telegram/ladder";
import { CrossPostError, deleteCrossPost, setTelegramTargets, sweepCrossPosts } from "../lib/channels/crosspost";
import { publishToTelegram } from "../lib/channels/telegram";
import { adapterFor } from "../lib/channels/registry";
import type { BotIO } from "../lib/telegram/onboarding";
import { db, resetDb } from "./helpers/db-instance";

const OWNER_TG = 5001;
const STRANGER_TG = 6666;
const CHANNEL = -1001;
const GROUP = -1002;
const DM_CHAT = -1003;

const FULL_RIGHTS = { status: "administrator", can_post_messages: true, can_edit_messages: true, can_delete_messages: true, can_manage_direct_messages: true } as const;

function seed(role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") {
  db.seed("workspace", { id: "w1", ownerId: "user1" });
  db.seed("user", { id: "user1", email: "owner@example.com" });
  db.seed("workspaceMember", { workspaceId: "w1", userId: "user1", role });
  db.seed("telegramUser", { tgUserId: String(OWNER_TG), userId: "user1", workspaceId: "w1", language: "uz" });
}

function seedChannel(overrides: Record<string, unknown> = {}) {
  return db.seed("telegramChannel", {
    id: "ch1",
    workspaceId: "w1",
    chatId: String(CHANNEL),
    title: "Do'kon",
    linkedChatId: String(GROUP),
    discussionReady: true,
    addedByTgUserId: String(OWNER_TG),
    ...overrides,
  });
}

function promoted(from: number, member: Record<string, unknown> = FULL_RIGHTS, chat: Record<string, unknown> = { id: CHANNEL, type: "channel", title: "Do'kon" }): TgMyChatMember {
  return { chat: chat as unknown as TgMyChatMember["chat"], from: { id: from }, new_chat_member: member as TgMyChatMember["new_chat_member"] };
}

let updateId = 1;
const ioSent: Array<{ chatId: string; text: string }> = [];
const io: BotIO = {
  send: async (chatId, text) => {
    ioSent.push({ chatId, text });
    return { message_id: ioSent.length };
  },
  edit: async () => ({}),
  download: async () => Buffer.from(""),
};

beforeEach(() => {
  resetDb();
  redisStore.clear();
  ioSent.length = 0;
  vi.clearAllMocks();
});

describe("connecting a channel (my_chat_member)", () => {
  it("leaves a channel added by a Telegram user who is not linked — nothing is stored", async () => {
    seed();
    expect(await handleChannelMembership(promoted(STRANGER_TG))).toBe("left_foreign");
    expect(leaveChat).toHaveBeenCalledWith(String(CHANNEL));
    expect(db.rows("telegramChannel")).toHaveLength(0);
  });

  it("leaves when the linked user cannot manage the workspace", async () => {
    seed("MEMBER");
    expect(await handleChannelMembership(promoted(OWNER_TG))).toBe("left_foreign");
    expect(leaveChat).toHaveBeenCalled();
    expect(db.rows("telegramChannel")).toHaveLength(0);
  });

  it("connects for a linked manager, reads the discussion group and reports every missing right", async () => {
    seed();
    const outcome = await handleChannelMembership(promoted(OWNER_TG, { status: "administrator", can_post_messages: true, can_edit_messages: true, can_delete_messages: true }));
    expect(outcome).toBe("connected");
    const row = db.rows("telegramChannel")[0];
    expect(row).toMatchObject({ workspaceId: "w1", chatId: String(CHANNEL), status: "ACTIVE", linkedChatId: String(GROUP), discussionReady: true, username: "dokon" });
    expect(row.missingRights).toEqual(["can_manage_direct_messages"]);
    expect(vi.mocked(sendMessage).mock.calls[0][1]).toContain("Kanal DM'larini boshqarish");
    expect(leaveChat).not.toHaveBeenCalled();
  });

  it("marks MISSING_RIGHTS when the bot cannot post", async () => {
    seed();
    await handleChannelMembership(promoted(OWNER_TG, { status: "administrator", can_post_messages: false }));
    const row = db.rows("telegramChannel")[0];
    expect(row.status).toBe("MISSING_RIGHTS");
    expect(row.missingRights).toEqual(expect.arrayContaining(["can_post_messages", "can_edit_messages", "can_delete_messages"]));
  });

  it("a stranger changing the bot's rights in a connected channel cannot take it over", async () => {
    seed();
    seedChannel();
    db.seed("workspace", { id: "w2", ownerId: "user2" });
    db.seed("user", { id: "user2", email: "x@example.com" });
    db.seed("workspaceMember", { workspaceId: "w2", userId: "user2", role: "OWNER" });
    db.seed("telegramUser", { tgUserId: String(STRANGER_TG), userId: "user2", workspaceId: "w2", language: "uz" });
    expect(await handleChannelMembership(promoted(STRANGER_TG, { status: "administrator", can_post_messages: true }))).toBe("updated");
    const row = db.rows("telegramChannel")[0];
    expect(row.workspaceId).toBe("w1");
    expect(row.status).toBe("MISSING_RIGHTS");
    expect(leaveChat).not.toHaveBeenCalled();
  });

  it("removal marks the channel REMOVED and alerts the workspace", async () => {
    seed();
    seedChannel();
    expect(await handleChannelMembership(promoted(OWNER_TG, { status: "left" }))).toBe("removed");
    expect(db.rows("telegramChannel")[0].status).toBe("REMOVED");
    expect(notify).toHaveBeenCalledWith("w1", expect.stringContaining("uzildi"));
  });

  it("the discussion group's admin status flips discussionReady", async () => {
    seed();
    seedChannel({ discussionReady: false });
    expect(await handleChannelMembership(promoted(OWNER_TG, { status: "administrator" }, { id: GROUP, type: "supergroup" }))).toBe("discussion");
    expect(db.rows("telegramChannel")[0].discussionReady).toBe(true);
  });

  it("an unrelated group is left to the lead-delivery logic", async () => {
    seed();
    expect(await handleChannelMembership(promoted(OWNER_TG, { status: "member" }, { id: -555, type: "group" }))).toBe("ignored");
    expect(leaveChat).not.toHaveBeenCalled();
  });

  it("routes my_chat_member through the bot entry point", async () => {
    seed();
    await handleTelegramUpdate({ update_id: updateId++, my_chat_member: promoted(STRANGER_TG) } as TgUpdate, io);
    expect(leaveChat).toHaveBeenCalled();
  });
});

describe("inbound: comments and channel DMs", () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    message_id: 42,
    from: { id: 777, first_name: "Ali", username: "ali" },
    chat: { id: GROUP, type: "supergroup" as const },
    text: "Narxi qancha?",
    message_thread_id: 10,
    reply_to_message: { message_id: 10, is_automatic_forward: true },
    ...over,
  });

  it("stores a comment under a channel post and alerts once per thread with a reply button", async () => {
    seed();
    seedChannel();
    expect(await routeChannelMessage(comment())).toBe(true);
    expect(await routeChannelMessage(comment({ message_id: 43 }))).toBe(true);
    const rows = db.rows("channelMessage");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "comment", threadRef: "10", direction: "IN", authorName: "@ali", text: "Narxi qancha?" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toEqual({ keyboard: [[{ text: "✍️ Shu yerdan javob", callback_data: `jai:treply:${rows[0].id}` }]] });
  });

  it("a redelivered comment is stored once", async () => {
    seed();
    seedChannel();
    await routeChannelMessage(comment());
    await routeChannelMessage(comment());
    expect(db.rows("channelMessage")).toHaveLength(1);
  });

  it("commands, plain group chat and the post's own forward fall through", async () => {
    seed();
    seedChannel();
    expect(await routeChannelMessage(comment({ text: "/start abc" }))).toBe(false);
    expect(await routeChannelMessage(comment({ message_thread_id: undefined, reply_to_message: undefined }))).toBe(false);
    expect(await routeChannelMessage(comment({ is_automatic_forward: true }))).toBe(false);
    expect(db.rows("channelMessage")).toHaveLength(0);
  });

  it("learns the channel DM chat from parent_chat and stores the message by topic", async () => {
    seed();
    seedChannel();
    vi.mocked(getChat).mockResolvedValueOnce({ id: DM_CHAT, type: "supergroup", is_direct_messages: true, parent_chat: { id: CHANNEL, type: "channel" } });
    const handled = await routeChannelMessage({
      message_id: 5,
      from: { id: 888, first_name: "Vali" },
      chat: { id: DM_CHAT, type: "supergroup", is_direct_messages: true },
      text: "Salom",
      direct_messages_topic: { topic_id: 31 },
    });
    expect(handled).toBe(true);
    expect(db.rows("telegramChannel")[0].dmChatId).toBe(String(DM_CHAT));
    expect(db.rows("channelMessage")[0]).toMatchObject({ kind: "channel_dm", threadRef: "31", authorName: "Vali" });
  });

  it("an edited comment updates the stored text", async () => {
    seed();
    seedChannel();
    await routeChannelMessage(comment());
    await handleTelegramUpdate({ update_id: updateId++, edited_message: comment({ text: "Narxi va yetkazish?" }) } as TgUpdate, io);
    expect(db.rows("channelMessage")[0]).toMatchObject({ text: "Narxi va yetkazish?" });
    expect(db.rows("channelMessage")[0].editedAt).toBeInstanceOf(Date);
  });
});

describe("replies", () => {
  async function storedComment() {
    seed();
    seedChannel();
    await routeChannelMessage({
      message_id: 42,
      from: { id: 777, first_name: "Ali" },
      chat: { id: GROUP, type: "supergroup" },
      text: "Narxi?",
      message_thread_id: 10,
    });
    return db.rows("channelMessage")[0].id as string;
  }

  it("answers a comment as a reply in the discussion group and records it", async () => {
    const id = await storedComment();
    const result = await replyToChannelMessage("w1", id, "120 000 so'm", "user1");
    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(String(GROUP), "120 000 so'm", expect.objectContaining({ replyTo: 42, parseMode: null }));
    expect(db.rows("channelMessage").find((m) => m.direction === "OUT")).toMatchObject({ text: "120 000 so'm", sentByUserId: "user1" });
  });

  it("answers a channel DM into its topic", async () => {
    seed();
    seedChannel({ dmChatId: String(DM_CHAT) });
    await routeChannelMessage({ message_id: 5, from: { id: 888 }, chat: { id: DM_CHAT, type: "supergroup", is_direct_messages: true }, text: "Salom", direct_messages_topic: { topic_id: 31 } });
    const id = db.rows("channelMessage")[0].id as string;
    expect((await replyToChannelMessage("w1", id, "Assalomu alaykum", null)).ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(String(DM_CHAT), "Assalomu alaykum", expect.objectContaining({ directMessagesTopicId: 31 }));
  });

  it("refuses a channel DM reply without the DM right, with the right named", async () => {
    seed();
    seedChannel({ dmChatId: String(DM_CHAT), missingRights: ["can_manage_direct_messages"] });
    await routeChannelMessage({ message_id: 5, from: { id: 888 }, chat: { id: DM_CHAT, type: "supergroup", is_direct_messages: true }, text: "Salom", direct_messages_topic: { topic_id: 31 } });
    const result = await replyToChannelMessage("w1", db.rows("channelMessage")[0].id as string, "Salom", null);
    expect(result).toEqual({ ok: false, error: "Botga «Kanal DM'larini boshqarish» huquqi berilmagan" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("another workspace cannot answer this workspace's message", async () => {
    const id = await storedComment();
    expect(await replyToChannelMessage("w2", id, "hi", null)).toEqual({ ok: false, error: "Xabar topilmadi" });
  });

  it("explains a Telegram rate limit instead of failing silently", async () => {
    const id = await storedComment();
    vi.mocked(sendMessage).mockRejectedValue(new TelegramApiError("sendMessage", 429, "Too Many Requests", 120));
    const result = await replyToChannelMessage("w1", id, "hi", null);
    vi.mocked(sendMessage).mockReset();
    vi.mocked(sendMessage).mockResolvedValue({ message_id: 900 });
    expect(result).toEqual({ ok: false, error: "Telegram cheklovi: 120 soniyadan keyin urinib ko'ring" });
  });

  it("the Telegram alert button collects the next text as the answer", async () => {
    const id = await storedComment();
    db.seed("integration", { id: "int1", workspaceId: "w1", type: "TELEGRAM" });
    db.seed("telegramChat", { integrationId: "int1", chatId: "-200", active: true });
    expect(await handleLadderCallback(io, "-200", String(OWNER_TG), `jai:treply:${id}`)).toBe(true);
    expect(await handleLadderText(io, "-200", String(OWNER_TG), "Ertaga yetkazamiz")).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(String(GROUP), "Ertaga yetkazamiz", expect.objectContaining({ replyTo: 42 }));
    expect(ioSent.at(-1)?.text).toContain("javob berildi");
  });
});

describe("Telegram Business", () => {
  const connection = (over: Record<string, unknown> = {}) => ({ id: "bc1", user: { id: OWNER_TG }, user_chat_id: OWNER_TG, is_enabled: true, rights: { can_reply: true }, ...over });

  it("refuses a connection from an unlinked account", async () => {
    seed();
    expect(await handleBusinessConnection(connection({ user: { id: STRANGER_TG }, user_chat_id: STRANGER_TG }))).toBe("refused");
    expect(db.rows("telegramBusinessConnection")).toHaveLength(0);
  });

  it("stores messages, replies with business_connection_id, tracks edits and deletions", async () => {
    seed();
    expect(await handleBusinessConnection(connection())).toBe("saved");
    const message = { message_id: 7, business_connection_id: "bc1", from: { id: 999, first_name: "Mijoz" }, chat: { id: 999, type: "private" as const }, text: "Bormi?" };
    await handleTelegramUpdate({ update_id: updateId++, business_message: message } as TgUpdate, io);
    const stored = db.rows("channelMessage")[0];
    expect(stored).toMatchObject({ kind: "business_dm", direction: "IN", threadRef: "999" });

    expect((await replyToChannelMessage("w1", stored.id as string, "Bor", null)).ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("999", "Bor", expect.objectContaining({ businessConnectionId: "bc1" }));

    await handleTelegramUpdate({ update_id: updateId++, edited_business_message: { ...message, text: "Bormi hozir?" } } as TgUpdate, io);
    expect(db.rows("channelMessage")[0].text).toBe("Bormi hozir?");
    await handleTelegramUpdate({ update_id: updateId++, deleted_business_messages: { business_connection_id: "bc1", chat: { id: 999 }, message_ids: [7] } } as TgUpdate, io);
    expect(db.rows("channelMessage")[0].deletedAt).toBeInstanceOf(Date);
  });

  it("never answers without can_reply", async () => {
    seed();
    await handleBusinessConnection(connection({ rights: { can_reply: false } }));
    await handleTelegramUpdate({ update_id: updateId++, business_message: { message_id: 8, business_connection_id: "bc1", from: { id: 999 }, chat: { id: 999, type: "private" }, text: "?" } } as TgUpdate, io);
    const result = await replyToChannelMessage("w1", db.rows("channelMessage")[0].id as string, "Ha", null);
    expect(result).toEqual({ ok: false, error: "Biznes ulanishda «javob berish» huquqi yo'q" });
  });

  it("a disabled connection stores nothing", async () => {
    seed();
    await handleBusinessConnection(connection({ is_enabled: false }));
    await handleTelegramUpdate({ update_id: updateId++, business_message: { message_id: 9, business_connection_id: "bc1", from: { id: 999 }, chat: { id: 999, type: "private" }, text: "?" } } as TgUpdate, io);
    expect(db.rows("channelMessage")).toHaveLength(0);
  });
});

describe("publishing and cross-posts", () => {
  it("text, single photo with a long caption, and an album", async () => {
    expect(await publishToTelegram("-1", { format: "text", text: "Yangi", idempotencyKey: "k" })).toEqual([900]);

    const long = "x".repeat(1500);
    expect(await publishToTelegram("-1", { format: "image", text: long, mediaUrls: ["https://m/1.jpg"], idempotencyKey: "k" })).toEqual([901, 900]);
    expect(sendPhoto).toHaveBeenCalledWith("-1", "https://m/1.jpg", expect.objectContaining({ caption: undefined }));

    const ids = await publishToTelegram("-1", { format: "carousel", text: "Albom", mediaUrls: ["https://m/1.jpg", "https://m/2.mp4"], options: { kinds: ["photo", "video"] }, idempotencyKey: "k" });
    expect(ids).toEqual([910, 911]);
    expect(vi.mocked(sendMediaGroup).mock.calls[0][1]).toEqual([
      { type: "photo", media: "https://m/1.jpg", caption: "Albom" },
      { type: "video", media: "https://m/2.mp4", caption: undefined },
    ]);
  });

  it("refuses a video over the 50 MB Bot API limit with a clear error", async () => {
    await expect(
      publishToTelegram("-1", { format: "video", text: "", mediaUrls: ["https://m/big.mp4"], options: { kinds: ["video"], sizes: [60 * 1024 * 1024] }, idempotencyKey: "k" })
    ).rejects.toThrow("50 MB");
  });

  it("the registry serves the Telegram adapter", () => {
    expect(adapterFor("telegram")?.channel).toBe("telegram");
  });

  function seedPost(over: Record<string, unknown> = {}) {
    db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "dokon", instagramId: "ig1" });
    return db.seed("scheduledPost", { id: "p1", workspaceId: "w1", instagramAccountId: "a1", type: "FEED_IMAGE", status: "SCHEDULED", caption: "Yangi kolleksiya", scheduledAt: new Date(Date.now() - 60_000), ...over });
  }

  it("targets only this workspace's live channels; stories are refused", async () => {
    seed();
    seedChannel();
    seedPost();
    await expect(setTelegramTargets("w1", "p1", ["nope"])).rejects.toBeInstanceOf(CrossPostError);
    await expect(setTelegramTargets("w2", "p1", ["ch1"])).rejects.toThrow("Post topilmadi");
    expect(await setTelegramTargets("w1", "p1", ["ch1"])).toHaveLength(1);
    db.rows("scheduledPost")[0].type = "STORY";
    await expect(setTelegramTargets("w1", "p1", ["ch1"])).rejects.toThrow("Story");
  });

  it("the sweep publishes a due post with its media and records the message ids", async () => {
    seed();
    seedChannel();
    seedPost();
    db.seed("mediaAsset", { id: "m1", workspaceId: "w1", kind: "IMAGE", originalKey: "orig.jpg", preparedKey: "prep.jpg", mimeType: "image/jpeg", sizeBytes: BigInt(1000), preparedBytes: 900 });
    db.seed("scheduledPostMedia", { postId: "p1", mediaId: "m1", position: 0 });
    await setTelegramTargets("w1", "p1", ["ch1"]);
    const result = await sweepCrossPosts();
    expect(result.published).toBe(1);
    expect(sendPhoto).toHaveBeenCalledWith(String(CHANNEL), "https://media.example/prep.jpg", expect.objectContaining({ caption: "Yangi kolleksiya" }));
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "PUBLISHED", externalIds: ["901"] });

    expect(await deleteCrossPost("w1", db.rows("channelPostTarget")[0].id as string)).toBe(true);
    expect(deleteMessage).toHaveBeenCalledWith(String(CHANNEL), 901);
    expect(db.rows("channelPostTarget")[0].status).toBe("DELETED");
  });

  it("waits for the slot, skips canceled posts, fails without the posting right", async () => {
    seed();
    seedChannel();
    seedPost({ scheduledAt: new Date(Date.now() + 3_600_000) });
    await setTelegramTargets("w1", "p1", ["ch1"]);
    expect((await sweepCrossPosts()).published).toBe(0);
    expect(db.rows("channelPostTarget")[0].status).toBe("PENDING");

    db.rows("scheduledPost")[0].scheduledAt = new Date(Date.now() - 60_000);
    db.rows("telegramChannel")[0].missingRights = ["can_post_messages"];
    expect((await sweepCrossPosts()).failed).toBe(1);
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "FAILED", lastError: "Botda «Xabar joylash» huquqi yo'q" });
    expect(notify).toHaveBeenCalledWith("w1", expect.stringContaining("Telegram'ga post chiqmadi"));

    await setTelegramTargets("w1", "p1", ["ch1"]); // re-selecting = retry
    db.rows("scheduledPost")[0].status = "CANCELED";
    expect((await sweepCrossPosts()).skipped).toBe(1);
    expect(db.rows("channelPostTarget")[0].status).toBe("SKIPPED");
  });

  it("retries a rate-limited publish on the next sweep instead of failing", async () => {
    seed();
    seedChannel();
    seedPost({ type: "FEED_IMAGE" });
    await setTelegramTargets("w1", "p1", ["ch1"]);
    vi.mocked(sendMessage).mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, "Too Many Requests", 60));
    const result = await sweepCrossPosts();
    expect(result.retried).toBe(1);
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "PENDING", attempts: 1 });
    expect((await sweepCrossPosts()).published).toBe(1);
  });

  it("checkCredentials needs the bot to be a posting admin", async () => {
    const adapter = adapterFor("telegram")!;
    vi.mocked(getChatMember).mockResolvedValueOnce({ status: "administrator", can_post_messages: false });
    expect(await adapter.checkCredentials({ accessToken: "", externalAccountId: String(CHANNEL) })).toEqual({ ok: false, error: "auth" });
    vi.mocked(getChatMember).mockResolvedValueOnce({ status: "administrator", can_post_messages: true });
    expect(await adapter.checkCredentials({ accessToken: "", externalAccountId: String(CHANNEL) })).toEqual({ ok: true });
  });
});
