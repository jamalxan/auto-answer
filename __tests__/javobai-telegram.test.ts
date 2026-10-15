/**
 * The "jai:take" / "jai:close" Telegram buttons under a JavobAI handoff
 * alert: scoped to the workspace the chat is connected to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("TELEGRAM_BOT_USERNAME", "SocialAutoLeadsBot");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({ set: async () => "OK" }) }));
vi.mock("../lib/queue/assistant-queue", () => ({ scheduleReply: vi.fn(), enqueueDelivery: vi.fn(), enqueueNotify: vi.fn() }));
vi.mock("../lib/telegram/api", async (original) => ({
  ...(await original<typeof import("../lib/telegram/api")>()),
  answerCallbackQuery: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => ({})),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
}));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 1), alertWorkspace: vi.fn(), sendWithRetry: vi.fn() }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));

import { handleTelegramUpdate, type TgUpdate } from "../lib/telegram/bot";
import type { BotIO } from "../lib/telegram/onboarding";
import { db, resetDb } from "./helpers/db-instance";

type Sent = { chatId: string; text: string };

function fakeIo() {
  const sent: Sent[] = [];
  const io: BotIO = {
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    edit: async () => ({}),
    download: async () => Buffer.alloc(0),
  };
  return { io, sent };
}

let updateId = 1000;
const press = (data: string, chatId: number): TgUpdate => ({
  update_id: ++updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: 555, language_code: "uz", username: "manager" },
    message: { message_id: 7, chat: { id: chatId, type: "supergroup", title: "Leads" } },
    data,
  },
});

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "user1" });
  db.seed("workspace", { id: "w2", ownerId: "user2" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "mebel", instagramId: "ig1" });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  const other = db.seed("integration", { id: "int_tg2", workspaceId: "w2", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: other.id, chatId: "-200" });
  const c = db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", igUsername: "ali", assistantState: "HANDED_OFF" });
  db.seed("aiConversationState", { conversationId: c.id, handoffState: "HANDOFF_PENDING", score: 65, temperature: "HOT" });
  db.seed("aiHandoff", { conversationId: c.id, reason: "purchase_ready", status: "OPEN" });
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  seed();
});

describe("jai: callbacks", () => {
  it("'Qabul qildim' from the workspace's chat → OPERATOR_ACTIVE, 24h mute", async () => {
    const { io, sent } = fakeIo();
    await handleTelegramUpdate(press("jai:take:c1", -100), io);
    expect(db.rows("aiConversationState")[0].handoffState).toBe("OPERATOR_ACTIVE");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "ACCEPTED", acceptedBy: "tg:@manager" });
    expect(db.rows("conversation")[0].operatorActiveUntil).toBeInstanceOf(Date);
    expect(sent[0]).toMatchObject({ chatId: "-100" });
    expect(sent[0].text).toContain("@ali");
  });

  it("'Yopish' → CLOSED, mute lifted so the AI resumes on the next message", async () => {
    const { io, sent } = fakeIo();
    await handleTelegramUpdate(press("jai:take:c1", -100), io);
    await handleTelegramUpdate(press("jai:close:c1", -100), io);
    expect(db.rows("aiConversationState")[0].handoffState).toBe("CLOSED");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "CLOSED", closedBy: "tg:@manager", resumeAi: true });
    expect(db.rows("conversation")[0].operatorActiveUntil).toBeNull();
    expect(sent[1].text).toContain("yopildi");
  });

  it("a chat of another workspace changes nothing", async () => {
    const { io, sent } = fakeIo();
    await handleTelegramUpdate(press("jai:take:c1", -200), io);
    expect(db.rows("aiConversationState")[0].handoffState).toBe("HANDOFF_PENDING");
    expect(sent).toHaveLength(0);
  });

  it("ignores unknown actions and conversations", async () => {
    const { io, sent } = fakeIo();
    await handleTelegramUpdate(press("jai:nuke:c1", -100), io);
    await handleTelegramUpdate(press("jai:take:nope", -100), io);
    expect(db.rows("aiConversationState")[0].handoffState).toBe("HANDOFF_PENDING");
    expect(sent).toHaveLength(0);
  });
});
