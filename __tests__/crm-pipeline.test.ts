/**
 * ETAP 5.2 — pipeline: lazy seed, Lead → deal, Kanban moves, WON / LOST
 * write-back to JavobAI's temperature, "Bog'lanildi" by event, stage editor
 * validation. In-memory database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { DEFAULT_STAGES } from "../lib/crm/defaults";
import { clearCrmListeners, registerCrmListener, type CrmEvent } from "../lib/crm/hooks";
import {
  DEALS_PER_STAGE,
  ensureDealForLead,
  ensureDefaultPipeline,
  listDeals,
  listPipelines,
  markLeadContacted,
  moveDeal,
  STAGE_HAS_DEALS,
  updateStages,
  type StageInput,
} from "../lib/crm/pipeline";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;

function seedWorld() {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
  db.seed("user", { id: "user1", email: "op@x.uz" });
  db.seed("workspaceMember", { id: "m1", workspaceId: "w1", userId: "user1", role: "OPERATOR" });
}

function seedLead(extra: Row = {}) {
  const conversation = db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", igUsername: "aziz" });
  return db.seed("lead", {
    id: "l1", workspaceId: "w1", instagramAccountId: "a1", conversationId: conversation.id, igUserId: "u1", igUsername: "aziz",
    name: "Aziz", phoneE164: "+998901234567", productInterest: "IELTS", idempotencyKey: "c1:0", summary: "Kurs so'radi", ...extra,
  });
}

const stageByName = (name: string) => {
  const stage = db.rows("crmStage").find((s) => s.name === name)!;
  return { ...stage, id: stage.id as string };
};

beforeEach(() => {
  resetDb();
  clearCrmListeners();
  seedWorld();
});

describe("ensureDefaultPipeline", () => {
  it("seeds the Uzbek default stages once", async () => {
    const first = await ensureDefaultPipeline("w1");
    const second = await ensureDefaultPipeline("w1");
    expect(second.id).toBe(first.id);
    expect(db.rows("crmPipeline")).toHaveLength(1);
    expect(first.stages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    expect(first.stages.filter((s) => s.isEntry).map((s) => s.name)).toEqual(["Yangi lead"]);
    expect(first.stages.find((s) => s.kind === "WON")?.name).toBe("Yutildi");
    const summary = await listPipelines("w1");
    expect(summary[0].stages.every((s) => s.dealCount === 0)).toBe(true);
  });
});

describe("ensureDealForLead", () => {
  it("creates one deal in the entry stage, links the contact, sets it ACTIVE and emits lead_created", async () => {
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    seedLead();
    const deal = await ensureDealForLead("l1");
    expect(deal).not.toBeNull();
    expect(await ensureDealForLead("l1")).toMatchObject({ id: deal!.id });
    expect(db.rows("crmDeal")).toHaveLength(1);
    expect(deal!.stageId).toBe(stageByName("Yangi lead").id);
    expect(deal!.title).toBe("Aziz — IELTS");
    const contact = db.rows("crmContact")[0];
    expect(contact).toMatchObject({ igUserId: "u1", phoneE164: "+998901234567", conversationId: "c1", status: "ACTIVE", source: "DM" });
    expect(db.rows("crmActivity").map((a) => a.type).sort()).toEqual(["DEAL_CREATED", "LEAD_CREATED"]);
    expect(seen.map((e) => e.kind)).toEqual(["lead_created"]);
    expect(await ensureDealForLead("nope")).toBeNull();
  });

  it("skips synthetic test leads and moves an already contacted lead on", async () => {
    seedLead({ isTest: true });
    expect(await ensureDealForLead("l1")).toBeNull();
    resetDb();
    seedWorld();
    seedLead({ contactedAt: new Date(), contactedByUserId: "user1" });
    const deal = await ensureDealForLead("l1");
    expect(db.rows("crmDeal")[0].stageId).toBe(stageByName("Bog'lanildi").id);
    expect(deal!.id).toBe(db.rows("crmDeal")[0].id);
  });

  it("silent (backfill / reconciler): same rows, no lead_created / stage_changed / lead_contacted events", async () => {
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    seedLead({ contactedAt: new Date(), contactedByUserId: "user1" });
    await ensureDealForLead("l1", { silent: true });
    expect(db.rows("crmDeal")[0].stageId).toBe(stageByName("Bog'lanildi").id);
    expect(db.rows("crmActivity").map((a) => a.type).sort()).toEqual(["DEAL_CREATED", "LEAD_CREATED", "STAGE_CHANGED"]);
    const deal = db.rows("crmDeal")[0];
    await moveDeal("w1", deal.id as string, stageByName("Hot").id, { kind: "SYSTEM" }, { silent: true });
    expect(seen).toEqual([]);
    await moveDeal("w1", deal.id as string, stageByName("Muzokara").id, { kind: "SYSTEM" });
    expect(seen.map((e) => e.kind)).toEqual(["stage_changed"]);
  });
});

describe("moveDeal", () => {
  it("WON → wonAt, contact CUSTOMER, JavobAI temperature CUSTOMER mirrored; back to open clears and re-scores", async () => {
    seedLead();
    db.seed("aiConversationState", { id: "s1", conversationId: "c1", score: 70, temperature: "HOT" });
    const deal = (await ensureDealForLead("l1"))!;
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));

    const won = await moveDeal("w1", deal.id, stageByName("Yutildi").id, { kind: "OPERATOR", memberId: "m1" });
    expect(won.ok && won.data.wonAt).toBeInstanceOf(Date);
    expect(db.rows("crmContact")[0]).toMatchObject({ status: "CUSTOMER", temperature: "CUSTOMER", hasAiState: true });
    expect(db.rows("aiConversationState")[0].temperature).toBe("CUSTOMER");
    const activity = db.rows("crmActivity").find((a) => a.type === "STAGE_CHANGED");
    expect(activity).toMatchObject({ actorKind: "OPERATOR", actorMemberId: "m1", title: "Bosqich: Yangi lead → Yutildi" });
    expect(seen[0]).toMatchObject({ kind: "stage_changed", stageKind: "WON", toStageId: stageByName("Yutildi").id });

    const lost = await moveDeal("w1", deal.id, stageByName("Yo'qotildi").id, { kind: "SYSTEM" }, { lostReason: "Narx yoqmadi" });
    expect(lost.ok && lost.data).toMatchObject({ wonAt: null, lostReason: "Narx yoqmadi" });
    expect(db.rows("crmContact")[0].status).toBe("LOST");
    expect(db.rows("aiConversationState")[0].temperature).toBe("LOST");

    const back = await moveDeal("w1", deal.id, stageByName("Muzokara").id, { kind: "SYSTEM" });
    expect(back.ok && back.data).toMatchObject({ wonAt: null, lostAt: null, lostReason: null });
    expect(db.rows("crmContact")[0]).toMatchObject({ status: "ACTIVE", temperature: "HOT" }); // score 70 ≥ default hot 60
    expect(db.rows("aiConversationState")[0].temperature).toBe("HOT");

    // Same stage: no-op, no activity.
    const before = db.rows("crmActivity").length;
    await moveDeal("w1", deal.id, stageByName("Muzokara").id, { kind: "SYSTEM" });
    expect(db.rows("crmActivity")).toHaveLength(before);
  });

  it("refuses another workspace's deal and a stage of another pipeline", async () => {
    seedLead();
    const deal = (await ensureDealForLead("l1"))!;
    expect((await moveDeal("w2", deal.id, stageByName("Yutildi").id, { kind: "SYSTEM" })).ok).toBe(false);
    const foreign = db.seed("crmStage", { pipelineId: "other", name: "X", sort: 0 });
    expect(await moveDeal("w1", deal.id, foreign.id as string, { kind: "SYSTEM" })).toMatchObject({ ok: false, status: 404 });
  });

  it("Kanban lists deals grouped by stage", async () => {
    seedLead();
    const deal = (await ensureDealForLead("l1"))!;
    await moveDeal("w1", deal.id, stageByName("Hot").id, { kind: "SYSTEM" });
    const board = await listDeals("w1");
    expect(board.ok).toBe(true);
    if (!board.ok) return;
    expect(board.data.total).toBe(1);
    const hot = board.data.columns.find((c) => c.stage.name === "Hot")!;
    expect(hot.deals[0]).toMatchObject({ id: deal.id, contact: { phoneE164: "+998901234567" } });
    expect(board.data.columns.find((c) => c.stage.name === "Yangi lead")!.deals).toEqual([]);
    expect(await listDeals("w1", "ghost")).toMatchObject({ ok: false, status: 404 });
  });

  it("Kanban caps each column at DEALS_PER_STAGE cards and reports the real count", async () => {
    const pipeline = await ensureDefaultPipeline("w1");
    const hot = stageByName("Hot");
    db.seed("crmContact", { id: "ct1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1" });
    const extra = 5;
    for (let i = 0; i < DEALS_PER_STAGE + extra; i++) {
      db.seed("crmDeal", { workspaceId: "w1", contactId: "ct1", pipelineId: pipeline.id, stageId: hot.id, title: `d${i}`, stageEnteredAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });
    }
    const board = await listDeals("w1");
    if (!board.ok) throw new Error(board.error);
    const column = board.data.columns.find((c) => c.stage.id === hot.id)!;
    expect(column.deals).toHaveLength(DEALS_PER_STAGE);
    expect(column.count).toBe(DEALS_PER_STAGE + extra);
    expect(column.deals[0].title).toBe(`d${DEALS_PER_STAGE + extra - 1}`); // newest stage entry first
    expect(board.data.total).toBe(DEALS_PER_STAGE + extra);
    expect(board.data.columns.find((c) => c.stage.name === "Yangi lead")).toMatchObject({ deals: [], count: 0 });
  });
});

describe("markLeadContacted", () => {
  it("moves an entry-stage deal to Bog'lanildi once, attributed to the member, and leaves later stages alone", async () => {
    seedLead();
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    expect(await markLeadContacted("missing")).toBeNull();
    const moved = await markLeadContacted("l1", { userId: "user1" }); // creates the deal on the way
    expect(moved!.stageId).toBe(stageByName("Bog'lanildi").id);
    expect(db.rows("crmActivity").find((a) => a.type === "STAGE_CHANGED")).toMatchObject({ actorKind: "OPERATOR", actorMemberId: "m1", sourceTable: "Lead", sourceId: "l1:contacted" });
    expect(seen.map((e) => e.kind)).toEqual(["lead_created", "stage_changed", "lead_contacted"]);

    const again = await markLeadContacted("l1");
    expect(again!.stageId).toBe(stageByName("Bog'lanildi").id);
    expect(db.rows("crmActivity").filter((a) => a.type === "STAGE_CHANGED")).toHaveLength(1);

    await moveDeal("w1", moved!.id, stageByName("Muzokara").id, { kind: "SYSTEM" });
    expect((await markLeadContacted("l1"))!.stageId).toBe(stageByName("Muzokara").id);
  });
});

describe("updateStages", () => {
  const inputs = (): StageInput[] => db.rows("crmStage").map((s) => ({ id: s.id as string, name: s.name as string, sort: s.sort as number, kind: s.kind as StageInput["kind"], color: s.color as string, isEntry: s.isEntry as boolean }));

  it("validates: exactly one entry, at most one WON / LOST, unique names", async () => {
    const pipeline = await ensureDefaultPipeline("w1");
    const noEntry = inputs().map((s) => ({ ...s, isEntry: false }));
    expect(await updateStages("w1", pipeline.id, noEntry)).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("kirish bosqichi") });
    const twoWon = inputs().map((s) => (s.name === "Hot" ? { ...s, kind: "WON" as const } : s));
    expect(await updateStages("w1", pipeline.id, twoWon)).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("Yutildi") });
    const dup = inputs().map((s) => (s.name === "Hot" ? { ...s, name: "muzokara" } : s));
    expect(await updateStages("w1", pipeline.id, dup)).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("takrorlanmasligi") });
    expect(await updateStages("w1", pipeline.id, [])).toMatchObject({ ok: false, status: 422 });
    expect(await updateStages("w2", pipeline.id, inputs())).toMatchObject({ ok: false, status: 404 });
    expect(await updateStages("w1", pipeline.id, [{ ...inputs()[0], id: "ghost" }, ...inputs().slice(1)])).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses to delete a stage that holds deals (422, Uzbek) and otherwise renames / reorders / adds / deletes", async () => {
    seedLead();
    await ensureDealForLead("l1");
    const pipeline = await ensureDefaultPipeline("w1");
    const withoutEntry = inputs().filter((s) => s.name !== "Yangi lead").map((s, i) => ({ ...s, isEntry: i === 0 }));
    const refused = await updateStages("w1", pipeline.id, withoutEntry);
    expect(refused).toMatchObject({ ok: false, status: 422, error: '"Yangi lead" bosqichida 1 ta bitim bor — avval ularni boshqa bosqichga ko\'chiring' });

    const edited: StageInput[] = inputs()
      .filter((s) => s.name !== "Saralangan")
      .map((s) => (s.name === "Hot" ? { ...s, name: "Issiq" } : s))
      .reverse()
      .map((s, i) => ({ ...s, sort: i }));
    edited.push({ name: "To'lov kutilmoqda", kind: "OPEN", color: "#F97316", sort: 99 });
    const result = await updateStages("w1", pipeline.id, edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stages.map((s) => s.name)).toEqual(["Yo'qotildi", "Yutildi", "Muzokara", "Issiq", "Bog'lanildi", "Yangi lead", "To'lov kutilmoqda"]);
    expect(result.data.stages.filter((s) => s.isEntry)).toHaveLength(1);
    expect(db.rows("crmStage").some((s) => String(s.name).startsWith("~tmp:"))).toBe(false);
  });

  it("a deal landing in the stage during the save (RESTRICT foreign key) is a 422 in Uzbek, not a 500", async () => {
    const pipeline = await ensureDefaultPipeline("w1");
    const edited = inputs().filter((s) => s.name !== "Saralangan");
    db.transactionError = Object.assign(new Error("Foreign key constraint violated: CrmDeal_stageId_fkey"), { code: "P2003" });
    try {
      expect(await updateStages("w1", pipeline.id, edited)).toEqual({ ok: false, status: 422, error: STAGE_HAS_DEALS });
    } finally {
      db.transactionError = null;
    }
  });

  it("deleting a stage deactivates and clears the ON_STAGE assignment rules that pointed at it", async () => {
    const pipeline = await ensureDefaultPipeline("w1");
    const doomed = stageByName("Saralangan");
    const kept = stageByName("Hot");
    db.seed("crmAssignmentRule", { id: "r_doomed", workspaceId: "w1", name: "Saralangan", trigger: "ON_STAGE", stageId: doomed.id, strategy: "ROUND_ROBIN", active: true });
    db.seed("crmAssignmentRule", { id: "r_kept", workspaceId: "w1", name: "Hot", trigger: "ON_STAGE", stageId: kept.id, strategy: "ROUND_ROBIN", active: true });
    const result = await updateStages("w1", pipeline.id, inputs().filter((s) => s.id !== doomed.id));
    expect(result.ok).toBe(true);
    const rule = (id: string) => db.rows("crmAssignmentRule").find((r) => r.id === id)!;
    expect(rule("r_doomed")).toMatchObject({ active: false, stageId: null });
    expect(rule("r_kept")).toMatchObject({ active: true, stageId: kept.id });
  });
});
