/**
 * ETAP 5.3 — assignment on the DB: rules CRUD validation, round robin with
 * a persisted cursor, SPECIALIST fallthrough, the Telegram alert with the
 * take / release buttons, take / release / manual permissions, listener
 * wiring, and the "crm:take" / "crm:release" bot callbacks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("TELEGRAM_BOT_USERNAME", "SocialAutoLeadsBot");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
// lib/workspace-access (imported by the bot) pulls next-auth through lib/auth; the bot never signs anyone in here.
vi.mock("../lib/auth", () => ({ getCurrentUserId: async () => null }));
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

import type { CrmContact } from "../app/generated/prisma/client";
import {
  assignContact,
  createRule,
  deleteRule,
  listRules,
  manualAssign,
  registerAssignmentListeners,
  releaseContact,
  takeContact,
  takeContactForLead,
  updateRule,
} from "../lib/crm/assignment";
import { clearCrmListeners, emitCrmEvent } from "../lib/crm/hooks";
import { answerCallbackQuery } from "../lib/telegram/api";
import { handleTelegramUpdate, type TgUpdate } from "../lib/telegram/bot";
import { notifyWorkspaceChats } from "../lib/telegram/notify";
import type { BotIO } from "../lib/telegram/onboarding";
import { db, resetDb } from "./helpers/db-instance";

type Edited = { chatId: string; messageId: number; text: string; keyboard?: unknown };

function fakeIo() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const edited: Edited[] = [];
  const io: BotIO = {
    send: async (chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    edit: async (chatId, messageId, text, options) => {
      edited.push({ chatId, messageId, text, keyboard: (options as { keyboard?: unknown } | undefined)?.keyboard });
      return {};
    },
    download: async () => Buffer.alloc(0),
  };
  return { io, sent, edited };
}

let updateId = 2000;
const press = (data: string, chatId: number, from = 555): TgUpdate => ({
  update_id: ++updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: from, language_code: "uz", username: `tg${from}` },
    message: { message_id: 7, chat: { id: chatId, type: "supergroup", title: "Leads" } },
    data,
  },
});

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u_owner", name: "Edu" });
  db.seed("workspace", { id: "w2", ownerId: "u_other", name: "Boshqa" });
  db.seed("user", { id: "u_owner", name: "Egasi", email: "owner@example.com" });
  db.seed("user", { id: "u_mgr", name: "Menejer", email: "mgr@example.com" });
  db.seed("user", { id: "u_op1", name: "Aziza", email: "op1@example.com" });
  db.seed("user", { id: "u_op2", name: "Bobur", email: "op2@example.com" });
  db.seed("user", { id: "u_view", name: "Kuzatuvchi", email: "view@example.com" });
  db.seed("user", { id: "u_other", name: "Begona", email: "other@example.com" });
  db.seed("workspaceMember", { id: "m_owner", workspaceId: "w1", userId: "u_owner", role: "OWNER" });
  db.seed("workspaceMember", { id: "m_mgr", workspaceId: "w1", userId: "u_mgr", role: "MANAGER" });
  db.seed("workspaceMember", { id: "m_op1", workspaceId: "w1", userId: "u_op1", role: "OPERATOR" });
  db.seed("workspaceMember", { id: "m_op2", workspaceId: "w1", userId: "u_op2", role: "MEMBER" });
  db.seed("workspaceMember", { id: "m_view", workspaceId: "w1", userId: "u_view", role: "VIEWER" });
  db.seed("workspaceMember", { id: "m_other", workspaceId: "w2", userId: "u_other", role: "OWNER" });
  db.seed("telegramUser", { tgUserId: "555", userId: "u_op1", workspaceId: "w1" });
  db.seed("telegramUser", { tgUserId: "556", userId: "u_op2", workspaceId: "w1" });
  db.seed("telegramUser", { tgUserId: "999", userId: "u_other", workspaceId: "w2" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "eduschool", instagramId: "ig1" });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  const other = db.seed("integration", { id: "int_tg2", workspaceId: "w2", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: other.id, chatId: "-200" });
  db.seed("crmContact", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_1", username: "ali", phoneE164: "+998901112233", conversationId: "conv1" });
  db.seed("crmContact", { id: "c2", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_2", username: "vali" });
  db.seed("crmContact", { id: "c3", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_3", username: "guli" });
  db.seed("crmContact", { id: "c9", workspaceId: "w2", instagramAccountId: "a2", igUserId: "ig_9", username: "other" });
}

const contact = (id: string) => db.rows("crmContact").find((row) => row.id === id) as unknown as CrmContact;
const active = (contactId: string) => db.rows("crmAssignment").filter((a) => a.contactId === contactId && a.active);
const rule = (id: string) => db.rows("crmAssignmentRule").find((r) => r.id === id)!;
const activities = (type: string) => db.rows("crmActivity").filter((a) => a.type === type);
const notify = notifyWorkspaceChats as unknown as ReturnType<typeof vi.fn>;
const keyboardOf = (call: unknown[]) => (call[2] as { keyboard: Array<Array<{ text: string; callback_data?: string }>> }).keyboard;

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  seed();
  clearCrmListeners();
  registerAssignmentListeners();
});

describe("rules CRUD", () => {
  it("validates members, keywords, trigger / stage / strategy consistency", async () => {
    await expect(createRule("w1", { name: "x", trigger: "ON_LEAD", strategy: "ROUND_ROBIN", memberIds: ["m_other"] })).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "ON_LEAD", strategy: "TEAM", memberIds: [] })).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "ON_LEAD", strategy: "SPECIALIST", memberIds: ["m_op1"], productKeywords: [] })).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "ON_STAGE", strategy: "ROUND_ROBIN" })).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "ON_STAGE", stageId: "nope", strategy: "ROUND_ROBIN" })).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "ON_LEAD", stageId: "s1", strategy: "ROUND_ROBIN" })).rejects.toMatchObject({ status: 422 });
    await expect(
      createRule("w1", { name: "x", trigger: "ON_LEAD", strategy: "SPECIALIST", memberIds: ["m_op1"], productKeywords: Array.from({ length: 21 }, (_, i) => `k${i}`) })
    ).rejects.toMatchObject({ status: 422 });
    await expect(createRule("w1", { name: "x", trigger: "WHEN", strategy: "ROUND_ROBIN" })).rejects.toMatchObject({ status: 422 });
    expect(db.rows("crmAssignmentRule")).toHaveLength(0);

    const pipeline = db.seed("crmPipeline", { workspaceId: "w1", name: "Asosiy voronka" });
    const stage = db.seed("crmStage", { pipelineId: pipeline.id, name: "Hot", sort: 3 });
    const created = await createRule("w1", { name: "Hot bosqichi", trigger: "ON_STAGE", stageId: stage.id, strategy: "TEAM", memberIds: ["m_op1", "m_op1", "m_op2"], productKeywords: [" ielts ", "ielts"] });
    expect(created).toMatchObject({ stageId: stage.id, memberIds: ["m_op1", "m_op2"], productKeywords: ["ielts"], rrCursor: 0, onlyUnassigned: true });
  });

  it("lists by priority, updates (pool change resets the cursor) and deletes, workspace-scoped", async () => {
    const low = await createRule("w1", { name: "Low", trigger: "ON_LEAD", strategy: "ROUND_ROBIN", priority: 0 });
    const high = await createRule("w1", { name: "High", trigger: "ON_LEAD", strategy: "ROUND_ROBIN", priority: 5 });
    expect((await listRules("w1")).map((r) => r.id)).toEqual([high.id, low.id]);
    expect(await listRules("w2")).toHaveLength(0);

    rule(low.id).rrCursor = 2;
    expect((await updateRule("w1", low.id, { name: "Low 2", priority: 1 })).rrCursor).toBe(2);
    expect((await updateRule("w1", low.id, { strategy: "TEAM", memberIds: ["m_op2"] })).rrCursor).toBe(0);
    await expect(updateRule("w1", low.id, { trigger: "ON_STAGE" })).rejects.toMatchObject({ status: 422 });
    await expect(updateRule("w2", low.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteRule("w2", low.id)).rejects.toMatchObject({ status: 404 });
    await deleteRule("w1", low.id);
    expect(db.rows("crmAssignmentRule")).toHaveLength(1);
  });
});

describe("assignContact", () => {
  it("round robin across two operators persists the cursor, closes the previous assignment and alerts Telegram with buttons", async () => {
    const rr = await createRule("w1", { name: "Navbat", trigger: "ON_HOT", strategy: "TEAM", memberIds: ["m_op1", "m_op2"] });

    const first = await assignContact({ workspaceId: "w1", contactId: "c1", trigger: "ON_HOT" });
    expect(first).toMatchObject({ assigned: true, memberId: "m_op1", ruleId: rr.id });
    expect(rule(rr.id).rrCursor).toBe(1);
    expect(contact("c1")).toMatchObject({ assignedMemberId: "m_op1" });
    expect(contact("c1").assignedAt).toBeInstanceOf(Date);

    const second = await assignContact({ workspaceId: "w1", contactId: "c2", trigger: "ON_HOT" });
    expect(second).toMatchObject({ assigned: true, memberId: "m_op2" });
    expect(rule(rr.id).rrCursor).toBe(0);
    const third = await assignContact({ workspaceId: "w1", contactId: "c3", trigger: "ON_HOT" });
    expect(third).toMatchObject({ assigned: true, memberId: "m_op1" });

    // A manual reassignment closes the previous active row, keeps history.
    await manualAssign("w1", "MANAGER", "c1", "m_op2", { memberId: "m_mgr", userId: "u_mgr" });
    const c1 = db.rows("crmAssignment").filter((a) => a.contactId === "c1");
    expect(c1).toHaveLength(2);
    expect(c1[0]).toMatchObject({ memberId: "m_op1", active: false, reason: `rule:${rr.id}`, ruleId: rr.id });
    expect(c1[0].unassignedAt).toBeInstanceOf(Date);
    expect(c1[1]).toMatchObject({ memberId: "m_op2", active: true, reason: "manual", assignedByUserId: "u_mgr" });
    expect(contact("c1").assignedMemberId).toBe("m_op2");
    expect(activities("ASSIGNED")).toHaveLength(4);
    expect(activities("ASSIGNED")[0]).toMatchObject({ contactId: "c1", actorKind: "AUTOMATION", title: "Operator biriktirildi: Aziza" });
    expect(activities("ASSIGNED")[3]).toMatchObject({ contactId: "c1", actorKind: "OPERATOR", actorMemberId: "m_mgr", payload: { previousMemberId: "m_op1", reason: "manual" } });

    // Telegram: workspace chat alert with take / release buttons (owner decision 3).
    expect(notify).toHaveBeenCalledTimes(4);
    const [workspaceId, text] = notify.mock.calls[0];
    expect(workspaceId).toBe("w1");
    expect(text).toContain("Kontakt biriktirildi");
    expect(text).toContain("@ali");
    expect(text).toContain("Aziza");
    expect(text).toContain("Kontakt HOT bo'lganda");
    const buttons = keyboardOf(notify.mock.calls[0]);
    expect(buttons[0].map((b) => b.callback_data)).toEqual(["crm:take:c1", "crm:release:c1"]);
    expect(buttons[1][0].text).toContain("Instagram");
  });

  it("onlyUnassigned rules leave an assigned contact alone; no rule → no assignment", async () => {
    expect(await assignContact({ workspaceId: "w1", contactId: "c1", trigger: "ON_LEAD" })).toEqual({ assigned: false, reason: "no_rule" });
    await createRule("w1", { name: "Navbat", trigger: "ON_LEAD", strategy: "ROUND_ROBIN" });
    await takeContact("w1", "c1", "m_op2", "telegram_take");
    expect(await assignContact({ workspaceId: "w1", contactId: "c1", trigger: "ON_LEAD" })).toEqual({ assigned: false, reason: "already_assigned" });
    expect(await assignContact({ workspaceId: "w1", contactId: "c9", trigger: "ON_LEAD" })).toEqual({ assigned: false, reason: "not_found" });
  });

  it("empty memberIds = every member with assign_leads (VIEWER skipped) in createdAt order", async () => {
    await createRule("w1", { name: "Hamma", trigger: "ON_LEAD", strategy: "ROUND_ROBIN" });
    const picks: string[] = [];
    for (const id of ["c1", "c2", "c3"]) {
      const result = await assignContact({ workspaceId: "w1", contactId: id, trigger: "ON_LEAD" });
      picks.push(result.assigned ? result.memberId : "none");
    }
    expect(picks).toEqual(["m_owner", "m_mgr", "m_op1"]);
    db.seed("crmContact", { id: "c4", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_4" });
    db.seed("crmContact", { id: "c5", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_5" });
    expect(await assignContact({ workspaceId: "w1", contactId: "c4", trigger: "ON_LEAD" })).toMatchObject({ memberId: "m_op2" });
    expect(await assignContact({ workspaceId: "w1", contactId: "c5", trigger: "ON_LEAD" })).toMatchObject({ memberId: "m_owner" }); // m_view skipped
  });

  it("SPECIALIST without a keyword match falls through to the next rule; with a match it wins", async () => {
    const specialist = await createRule("w1", { name: "IELTS", trigger: "ON_LEAD", strategy: "SPECIALIST", memberIds: ["m_op2"], productKeywords: ["ielts", "sat"], priority: 10 });
    const fallback = await createRule("w1", { name: "Navbat", trigger: "ON_LEAD", strategy: "TEAM", memberIds: ["m_op1"], priority: 0 });

    const plain = await assignContact({ workspaceId: "w1", contactId: "c1", trigger: "ON_LEAD", context: { leadProduct: "Mebel" } });
    expect(plain).toMatchObject({ assigned: true, memberId: "m_op1", ruleId: fallback.id });
    expect(rule(specialist.id).rrCursor).toBe(0);

    const ielts = await assignContact({ workspaceId: "w1", contactId: "c2", trigger: "ON_LEAD", context: { leadProduct: "IELTS kursi" } });
    expect(ielts).toMatchObject({ assigned: true, memberId: "m_op2", ruleId: specialist.id });
    expect(activities("ASSIGNED")[1].payload).toMatchObject({ matchedKeyword: "ielts" });

    // The product may also come from a tag or JavobAI's extracted state.
    const sat = db.seed("crmTag", { workspaceId: "w1", slug: "mahsulot:sat", name: "Mahsulot: SAT" });
    db.seed("crmContactTag", { contactId: "c3", tagId: sat.id, origin: "AI" });
    expect(await assignContact({ workspaceId: "w1", contactId: "c3", trigger: "ON_LEAD" })).toMatchObject({ memberId: "m_op2", ruleId: specialist.id });
  });

  it("retries when the cursor moved under it (lost race)", async () => {
    const rr = await createRule("w1", { name: "Navbat", trigger: "ON_HOT", strategy: "TEAM", memberIds: ["m_op1", "m_op2"] });
    // The client proxy hands out a fresh model object per access, so patch the factory.
    const originalModel = db.model.bind(db);
    let raced = false;
    db.model = (name: string) => {
      const model = originalModel(name);
      if (name !== "crmAssignmentRule") return model;
      const updateMany = model.updateMany;
      model.updateMany = async (args) => {
        if (!raced) {
          raced = true;
          rule(rr.id).rrCursor = 1; // another assignment advanced it first
        }
        return updateMany(args); // the first call's "where rrCursor = 0" no longer matches → count 0
      };
      return model;
    };
    try {
      expect(await assignContact({ workspaceId: "w1", contactId: "c1", trigger: "ON_HOT" })).toMatchObject({ assigned: true, memberId: "m_op2" });
      expect(rule(rr.id).rrCursor).toBe(0);
      expect(raced).toBe(true);
    } finally {
      db.model = originalModel;
    }
  });
});

describe("takeContact / releaseContact / manualAssign", () => {
  it("an OPERATOR cannot take a contact another member holds; MANAGER+ can", async () => {
    await takeContact("w1", "c1", "m_op1", "telegram_take");
    await expect(takeContact("w1", "c1", "m_op2", "telegram_take")).rejects.toMatchObject({ status: 403 });
    await expect(takeContact("w1", "c1", "m_op2", "inbox_reply")).rejects.toMatchObject({ status: 403 });
    expect(active("c1")[0].memberId).toBe("m_op1");
    expect(await takeContact("w1", "c1", "m_mgr", "telegram_take")).toMatchObject({ previousMemberId: "m_op1" });
    expect(active("c1")[0].memberId).toBe("m_mgr");
    // The holder itself re-taking is a no-op, not a refusal.
    await expect(takeContact("w1", "c1", "m_mgr", "telegram_take")).resolves.toMatchObject({ unchanged: true });
  });

  it("take needs a member with assign_leads; release is own-only for OPERATOR, anyone's for MANAGER+", async () => {
    await expect(takeContact("w1", "c1", "m_other", "telegram_take")).rejects.toMatchObject({ status: 403 });
    await expect(takeContact("w1", "c1", "m_view", "telegram_take")).rejects.toMatchObject({ status: 403 });
    await expect(takeContact("w1", "c9", "m_op1", "telegram_take")).rejects.toMatchObject({ status: 404 });

    const taken = await takeContact("w1", "c1", "m_op1", "telegram_take");
    expect(taken).toMatchObject({ previousMemberId: null, unchanged: false });
    expect(active("c1")[0]).toMatchObject({ memberId: "m_op1", reason: "telegram_take", assignedByUserId: "u_op1" });
    expect(notify).not.toHaveBeenCalled();
    // Taking again is a no-op.
    expect((await takeContact("w1", "c1", "m_op1", "telegram_take")).unchanged).toBe(true);
    expect(active("c1")).toHaveLength(1);

    await expect(releaseContact("w1", "c1", "m_op2")).rejects.toMatchObject({ status: 403 });
    expect(await releaseContact("w1", "c2", "m_op2")).toEqual({ released: false, previousMemberId: null });
    expect(await releaseContact("w1", "c1", "m_mgr")).toEqual({ released: true, previousMemberId: "m_op1" });
    expect(contact("c1")).toMatchObject({ assignedMemberId: null, assignedAt: null });
    expect(active("c1")).toHaveLength(0);
    expect(activities("UNASSIGNED")[0]).toMatchObject({ actorMemberId: "m_mgr", title: "Operator bo'shatildi: Menejer" });

    await takeContact("w1", "c1", "m_op1", "inbox_reply");
    expect(await releaseContact("w1", "c1", "m_op1")).toMatchObject({ released: true });
  });

  it("manualAssign: VIEWER 403, OPERATOR only to self, target must be assignable, MANAGER anyone", async () => {
    await expect(manualAssign("w1", "VIEWER", "c1", "m_op1", { memberId: "m_view" })).rejects.toMatchObject({ status: 403 });
    await expect(manualAssign("w1", "OPERATOR", "c1", "m_op2", { memberId: "m_op1" })).rejects.toMatchObject({ status: 403 });
    await expect(manualAssign("w1", "MEMBER", "c1", "m_op2", { memberId: "m_op1" })).rejects.toMatchObject({ status: 403 });
    await expect(manualAssign("w1", "MANAGER", "c1", "m_view", { memberId: "m_mgr" })).rejects.toMatchObject({ status: 422 });
    await expect(manualAssign("w1", "MANAGER", "c1", "m_other", { memberId: "m_mgr" })).rejects.toMatchObject({ status: 404 });

    await manualAssign("w1", "OPERATOR", "c1", "m_op1", { memberId: "m_op1", userId: "u_op1" });
    expect(contact("c1").assignedMemberId).toBe("m_op1");
    expect(notify).not.toHaveBeenCalled(); // self-assignment needs no alert

    await manualAssign("w1", "MANAGER", "c1", "m_op2", { memberId: "m_mgr", userId: "u_mgr" });
    expect(contact("c1").assignedMemberId).toBe("m_op2");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain("Qo'lda biriktirildi");
  });

  it("takeContactForLead maps the lead to its contact and the user to their member row", async () => {
    db.seed("lead", { id: "l1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_1", idempotencyKey: "k1" });
    expect(await takeContactForLead("l1", "u_view")).toBeNull();
    expect(await takeContactForLead("l1", "u_other")).toBeNull();
    expect(await takeContactForLead("nope", "u_op1")).toBeNull();
    const result = await takeContactForLead("l1", "u_op1");
    expect(result?.assignment).toMatchObject({ contactId: "c1", memberId: "m_op1", reason: "lead_contacted" });
  });
});

describe("listener", () => {
  const base = (id: string) => ({ workspaceId: "w1", contactId: id, contact: contact(id) });

  it("ON_LEAD on lead_created (deal + product), ON_HOT on becameHot, ON_HANDOFF on HANDOFF_OPENED, ON_STAGE on stage_changed", async () => {
    const pipeline = db.seed("crmPipeline", { workspaceId: "w1", name: "Asosiy voronka" });
    const stage = db.seed("crmStage", { pipelineId: pipeline.id, name: "Muzokara", sort: 4 });
    db.seed("crmDeal", { id: "d1", workspaceId: "w1", contactId: "c1", pipelineId: pipeline.id, stageId: stage.id, title: "Ali" });
    await createRule("w1", { name: "Lead", trigger: "ON_LEAD", strategy: "SPECIALIST", memberIds: ["m_op2"], productKeywords: ["ielts"] });
    await createRule("w1", { name: "Hot", trigger: "ON_HOT", strategy: "TEAM", memberIds: ["m_op1"] });
    await createRule("w1", { name: "Handoff", trigger: "ON_HANDOFF", strategy: "TEAM", memberIds: ["m_mgr"] });
    await createRule("w1", { name: "Stage", trigger: "ON_STAGE", stageId: stage.id, strategy: "TEAM", memberIds: ["m_owner"], onlyUnassigned: false });

    await emitCrmEvent({ ...base("c1"), kind: "lead_created", leadId: "l1", dealId: "d1", productInterest: "IELTS kursi" });
    expect(contact("c1").assignedMemberId).toBe("m_op2");
    expect(db.rows("crmDeal")[0].assignedMemberId).toBe("m_op2");
    expect(active("c1")[0]).toMatchObject({ dealId: "d1" });

    await emitCrmEvent({ ...base("c2"), kind: "score", score: 70, previousScore: 40, temperature: "HOT", previousTemperature: "WARM", becameHot: true });
    expect(contact("c2").assignedMemberId).toBe("m_op1");
    await emitCrmEvent({ ...base("c3"), kind: "score", score: 72, previousScore: 70, temperature: "HOT", previousTemperature: "HOT", becameHot: false });
    expect(contact("c3").assignedMemberId).toBeNull();

    await emitCrmEvent({ ...base("c3"), kind: "handoff", state: "HANDOFF_OPENED", conversationId: "conv3", handoffId: "h3" });
    expect(contact("c3").assignedMemberId).toBe("m_mgr");

    await emitCrmEvent({ ...base("c1"), kind: "stage_changed", dealId: "d1", fromStageId: null, toStageId: stage.id as string, stageKind: "OPEN", actor: { kind: "OPERATOR", memberId: "m_mgr" } });
    expect(contact("c1").assignedMemberId).toBe("m_owner");
  });

  it("HANDOFF_ACCEPTED by a linked Telegram user or a user id takes the contact; lead_contacted / operator reply too", async () => {
    db.seed("aiHandoff", { id: "h1", conversationId: "conv1", reason: "operator", status: "ACCEPTED", acceptedBy: "tg:556" });
    await emitCrmEvent({ ...base("c1"), kind: "handoff", state: "HANDOFF_ACCEPTED", conversationId: "conv1", handoffId: "h1" });
    expect(active("c1")[0]).toMatchObject({ memberId: "m_op2", reason: "telegram_take" });

    db.seed("aiHandoff", { id: "h2", conversationId: "conv2", reason: "operator", status: "ACCEPTED", acceptedBy: "u_op1" });
    await emitCrmEvent({ ...base("c2"), kind: "handoff", state: "HANDOFF_ACCEPTED", conversationId: "conv2", handoffId: "h2" });
    expect(active("c2")[0]).toMatchObject({ memberId: "m_op1", reason: "inbox_reply" });

    db.seed("aiHandoff", { id: "h3", conversationId: "conv3", reason: "operator", status: "ACCEPTED", acceptedBy: "tg:@someone" });
    await emitCrmEvent({ ...base("c3"), kind: "handoff", state: "HANDOFF_ACCEPTED", conversationId: "conv3", handoffId: "h3" });
    expect(active("c3")).toHaveLength(0);

    await emitCrmEvent({ ...base("c3"), kind: "lead_contacted", leadId: "l3", dealId: "d3", memberId: "m_mgr" });
    expect(active("c3")[0]).toMatchObject({ memberId: "m_mgr", reason: "lead_contacted" });

    // An operator reply takes an unassigned contact, never steals an assigned one.
    await emitCrmEvent({ ...base("c3"), kind: "interaction", direction: "outbound", via: "operator_reply", memberId: "m_op1", at: new Date() });
    expect(active("c3")[0].memberId).toBe("m_mgr");
    db.seed("crmContact", { id: "c4", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_4" });
    await emitCrmEvent({ ...base("c4"), kind: "interaction", direction: "outbound", via: "operator_reply", memberId: "m_op1", at: new Date() });
    expect(active("c4")[0]).toMatchObject({ memberId: "m_op1", reason: "inbox_reply" });
  });
});

describe("crm: bot callbacks", () => {
  it("'Qabul qildim' from the workspace chat assigns the presser's member row and edits the alert", async () => {
    const { io, edited } = fakeIo();
    await handleTelegramUpdate(press("crm:take:c1", -100, 555), io);
    expect(active("c1")[0]).toMatchObject({ memberId: "m_op1", reason: "telegram_take", assignedByUserId: "u_op1" });
    expect(contact("c1").assignedMemberId).toBe("m_op1");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ chatId: "-100", messageId: 7 });
    expect(edited[0].text).toContain("@ali");
    expect(edited[0].text).toContain("Qabul qildi: Aziza");
    const keyboard = edited[0].keyboard as Array<Array<{ callback_data?: string }>>;
    expect(keyboard[0].map((b) => b.callback_data)).toEqual(["crm:release:c1"]);

    // Another operator (legacy MEMBER = OPERATOR) presses: refused with the reason, the holder stays.
    await handleTelegramUpdate(press("crm:take:c1", -100, 556), io);
    expect(active("c1")[0].memberId).toBe("m_op1");
    expect(db.rows("crmAssignment").filter((a) => a.contactId === "c1")).toHaveLength(1);
    expect(vi.mocked(answerCallbackQuery).mock.calls.some(([, text]) => text?.includes("boshqa operatorga biriktirilgan"))).toBe(true);
    expect(edited).toHaveLength(1);
  });

  it("every crm: press is answered exactly once (success, unknown contact, refusal)", async () => {
    const { io } = fakeIo();
    const answers = () => vi.mocked(answerCallbackQuery).mock.calls.length;
    await handleTelegramUpdate(press("crm:take:c1", -100, 555), io);
    expect(answers()).toBe(1);
    expect(vi.mocked(answerCallbackQuery).mock.calls[0][1]).toContain("Qabul qilindi");
    await handleTelegramUpdate(press("crm:take:nope", -100, 555), io);
    expect(answers()).toBe(2);
    expect(vi.mocked(answerCallbackQuery).mock.calls[1][1]).toContain("Kontakt topilmadi");
    await handleTelegramUpdate(press("crm:take:c1", -100, 556), io);
    expect(answers()).toBe(3);
    await handleTelegramUpdate(press("crm:nuke:c1", -100, 555), io);
    expect(answers()).toBe(4);
  });

  it("'Bo'shatish' releases own assignment; releasing someone else's as OPERATOR answers with the error", async () => {
    const { io, edited } = fakeIo();
    await handleTelegramUpdate(press("crm:take:c1", -100, 555), io);
    await handleTelegramUpdate(press("crm:release:c1", -100, 556), io);
    expect(active("c1")[0].memberId).toBe("m_op1");
    expect(vi.mocked(answerCallbackQuery).mock.calls.some(([, text]) => text?.includes("o'zingizga"))).toBe(true);

    await handleTelegramUpdate(press("crm:release:c1", -100, 555), io);
    expect(active("c1")).toHaveLength(0);
    expect(contact("c1").assignedMemberId).toBeNull();
    expect(edited[1].text).toContain("Bo'shatildi: Aziza");
    const keyboard = edited[1].keyboard as Array<Array<{ callback_data?: string }>>;
    expect(keyboard[0].map((b) => b.callback_data)).toEqual(["crm:take:c1"]);
  });

  it("a chat of another workspace, an unlinked user or a foreign member changes nothing", async () => {
    const { io, edited } = fakeIo();
    await handleTelegramUpdate(press("crm:take:c1", -200, 555), io);
    await handleTelegramUpdate(press("crm:take:c1", -100, 777), io); // not linked
    await handleTelegramUpdate(press("crm:take:c1", -100, 999), io); // linked to w2
    await handleTelegramUpdate(press("crm:take:c9", -100, 555), io); // contact of w2
    await handleTelegramUpdate(press("crm:nuke:c1", -100, 555), io);
    await handleTelegramUpdate(press("crm:take:nope", -100, 555), io);
    expect(db.rows("crmAssignment")).toHaveLength(0);
    expect(edited).toHaveLength(0);
    expect(vi.mocked(answerCallbackQuery).mock.calls.some(([, text]) => text?.includes("/start"))).toBe(true);
  });
});
