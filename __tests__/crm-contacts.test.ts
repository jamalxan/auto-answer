/**
 * ETAP 5.0 — CrmContact upserts (idempotent, monotonic), list / search /
 * paging, status changes and the JavobAI state mirror. In-memory database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { recordActivity } from "../lib/crm/activity";
import {
  CONTACT_NOT_FOUND,
  findContactByConversation,
  getContact,
  listContacts,
  mirrorAiState,
  setContactStatus,
  upsertContactFromParts,
} from "../lib/crm/contacts";
import { clearCrmListeners, registerCrmListener, type CrmEvent } from "../lib/crm/hooks";
import { compileSegmentWhere } from "../lib/crm/segments";
import { db, resetDb } from "./helpers/db-instance";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 12, minutes));
const base = { workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1" };

beforeEach(() => {
  resetDb();
  clearCrmListeners();
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
});

describe("upsertContactFromParts", () => {
  it("creates one row per (account, igUserId) and is idempotent on replay", async () => {
    const first = await upsertContactFromParts({ ...base, username: "aziz", interactionAt: at(0), inbound: true });
    const again = await upsertContactFromParts({ ...base, username: "aziz", interactionAt: at(0), inbound: true });
    expect(again.id).toBe(first.id);
    expect(db.rows("crmContact")).toHaveLength(1);
    expect(again.interactionCount).toBe(1);
    expect(again.firstInteractionAt).toEqual(at(0));
    expect(again.lastInboundAt).toEqual(at(0));
    expect(again.status).toBe("NEW");
  });

  it("non-empty values win, empty ones never overwrite", async () => {
    await upsertContactFromParts({ ...base, name: "Aziz", phoneE164: "+998901234567" });
    const row = await upsertContactFromParts({ ...base, name: "", phoneE164: null, username: " aziz_ig " });
    expect(row.name).toBe("Aziz");
    expect(row.phoneE164).toBe("+998901234567");
    expect(row.username).toBe("aziz_ig");
    // An existing name is kept over a later different one.
    expect((await upsertContactFromParts({ ...base, name: "Other" })).name).toBe("Aziz");
  });

  it("moves first back, last forward, counts only newer interactions and keeps the window anchor on DMs", async () => {
    await upsertContactFromParts({ ...base, interactionAt: at(10), inbound: true });
    const older = await upsertContactFromParts({ ...base, interactionAt: at(5), inbound: true });
    expect(older.firstInteractionAt).toEqual(at(5));
    expect(older.lastInteractionAt).toEqual(at(10));
    expect(older.lastInboundAt).toEqual(at(10));
    expect(older.interactionCount).toBe(1); // older than the last: not a new interaction

    const comment = await upsertContactFromParts({ ...base, interactionAt: at(20), interaction: true });
    expect(comment.lastInteractionAt).toEqual(at(20));
    expect(comment.lastInboundAt).toEqual(at(10)); // comments do not open the messaging window
    expect(comment.interactionCount).toBe(2);

    const reply = await upsertContactFromParts({ ...base, interactionAt: at(21), outbound: true });
    expect(reply.lastOutboundAt).toEqual(at(21));
    expect(reply.lastInboundAt).toEqual(at(10));
    expect(reply.interactionCount).toBe(3);
  });

  it("takes the larger store counter on backfill and the earliest source only once", async () => {
    await upsertContactFromParts({ ...base, source: "COMMENT", interactionAt: at(0), inbound: true });
    const row = await upsertContactFromParts({ ...base, source: "DM", interactionAt: at(0), interaction: true, interactionCount: 7 });
    expect(row.source).toBe("COMMENT");
    expect(row.interactionCount).toBe(7);
    expect((await upsertContactFromParts({ ...base, interactionCount: 3 })).interactionCount).toBe(7);
  });

  it("links the conversation and trigger contact once and survives a link already taken", async () => {
    await upsertContactFromParts({ ...base, conversationId: "c1" });
    const other = await upsertContactFromParts({ ...base, igUserId: "u2", conversationId: "c1", instagramContactId: "ic2" });
    expect(other.conversationId).toBeNull(); // c1 belongs to u1
    expect(other.instagramContactId).toBe("ic2");
    const linked = await upsertContactFromParts({ ...base, instagramContactId: "ic1" });
    expect(linked.conversationId).toBe("c1");
    expect(linked.instagramContactId).toBe("ic1");
    expect((await findContactByConversation("c1"))?.id).toBe(linked.id);
  });

  it("emits an interaction event unless silent", async () => {
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    await upsertContactFromParts({ ...base, interactionAt: at(1), inbound: true }, { via: "inbound" });
    await upsertContactFromParts({ ...base, interactionAt: at(2), outbound: true, igUserId: "u2" }, { silent: true });
    await upsertContactFromParts({ ...base, igUserId: "u3" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "interaction", direction: "inbound", via: "inbound", workspaceId: "w1" });
  });

  it("emits only when the interaction moves its anchor forward (a replay or an older message is silent)", async () => {
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    await upsertContactFromParts({ ...base, interactionAt: at(5), inbound: true }, { via: "inbound" });
    await upsertContactFromParts({ ...base, interactionAt: at(5), inbound: true }, { via: "reconcile" }); // replay
    await upsertContactFromParts({ ...base, interactionAt: at(3), inbound: true }, { via: "reconcile" }); // older
    expect(seen).toHaveLength(1);
    await upsertContactFromParts({ ...base, interactionAt: at(6), outbound: true }, { via: "operator_reply" });
    await upsertContactFromParts({ ...base, interactionAt: at(6), outbound: true }, { via: "reconcile" });
    await upsertContactFromParts({ ...base, interactionAt: at(7), inbound: true }, { via: "inbound" });
    expect(seen.map((e) => (e.kind === "interaction" ? `${e.direction}:${e.via}` : e.kind))).toEqual(["inbound:inbound", "outbound:operator_reply", "inbound:inbound"]);
  });
});

describe("listContacts", () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      await upsertContactFromParts({ ...base, igUserId: `u${i}`, username: `user${i}`, name: i === 2 ? "Aziz Karimov" : null, phoneE164: i % 2 ? `+99890000000${i}` : null, interactionAt: at(i), inbound: true });
    }
    await upsertContactFromParts({ ...base, igUserId: "silent" }); // no interaction yet
    await upsertContactFromParts({ ...base, workspaceId: "w2", instagramAccountId: "a2", igUserId: "u0" });
  });

  it("pages newest activity first with a keyset cursor and scopes by workspace", async () => {
    const first = await listContacts("w1", { limit: 2 });
    expect(first.items.map((c) => c.igUserId)).toEqual(["u4", "u3"]);
    expect(first.total).toBe(6);
    expect(first.nextCursor).toBe(first.items[1].id);
    const second = await listContacts("w1", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((c) => c.igUserId)).toEqual(["u2", "u1"]);
    const last = await listContacts("w1", { limit: 2, cursor: second.nextCursor });
    expect(last.items.map((c) => c.igUserId)).toEqual(["u0", "silent"]); // nulls last
    expect(last.nextCursor).toBeNull();
  });

  it("searches username / name / phone and applies a compiled segment where", async () => {
    expect((await listContacts("w1", { q: "@user3" })).items.map((c) => c.igUserId)).toEqual(["u3"]);
    expect((await listContacts("w1", { q: "karimov" })).items.map((c) => c.igUserId)).toEqual(["u2"]);
    expect((await listContacts("w1", { q: "+998 9000 00001" })).items.map((c) => c.igUserId)).toEqual(["u1"]);
    const where = compileSegmentWhere({ v: 1, all: [{ field: "phone_present", op: "is_true" }] });
    const page = await listContacts("w1", { where });
    expect(page.items.map((c) => c.igUserId)).toEqual(["u3", "u1"]);
    expect(page.total).toBe(2);
  });

  it("getContact returns tags and deals, scoped", async () => {
    const row = (await listContacts("w1", { q: "user1" })).items[0];
    const full = await getContact("w1", row.id);
    expect(full?.tags).toEqual([]);
    expect(full?.deals).toEqual([]);
    expect(await getContact("w2", row.id)).toBeNull();
  });
});

describe("setContactStatus / recordActivity", () => {
  it("writes the status with a FIELD_CHANGED activity; unknown contact is 404", async () => {
    const c = await upsertContactFromParts(base);
    const result = await setContactStatus("w1", c.id, "ARCHIVED", { kind: "OPERATOR", memberId: "m1" });
    expect(result.ok && result.data.status).toBe("ARCHIVED");
    const activity = db.rows("crmActivity")[0];
    expect(activity).toMatchObject({ type: "FIELD_CHANGED", actorKind: "OPERATOR", actorMemberId: "m1", title: "Holat: Yangi → Arxiv" });
    expect(await setContactStatus("w2", c.id, "ACTIVE", { kind: "SYSTEM" })).toEqual({ ok: false, status: 404, error: CONTACT_NOT_FOUND });
  });

  it("recordActivity is idempotent on (sourceTable, sourceId, type)", async () => {
    const c = await upsertContactFromParts(base);
    const input = { workspaceId: "w1", contactId: c.id, type: "NOTE" as const, occurredAt: at(0), actorKind: "SYSTEM" as const, title: "x", sourceTable: "Lead", sourceId: "l1" };
    expect(await recordActivity(input)).not.toBeNull();
    expect(await recordActivity(input)).toBeNull();
    expect(await recordActivity({ ...input, type: "LEAD_CREATED" })).not.toBeNull();
    expect(db.rows("crmActivity")).toHaveLength(2);
  });
});

describe("mirrorAiState", () => {
  it("copies score / temperature, records changes once per state version and flags HOT", async () => {
    db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1" });
    const contact = await upsertContactFromParts({ ...base, conversationId: "c1" });
    expect(await mirrorAiState("missing")).toBeNull();
    expect((await mirrorAiState("c1"))?.hasAiState).toBe(false); // no state yet

    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    db.seed("aiConversationState", { id: "s1", conversationId: "c1", score: 65, temperature: "HOT" });
    const mirrored = await mirrorAiState("c1");
    expect(mirrored).toMatchObject({ id: contact.id, score: 65, temperature: "HOT", hasAiState: true });
    expect(db.rows("crmActivity").map((a) => a.type).sort()).toEqual(["SCORE_CHANGED", "TEMPERATURE_CHANGED"]);
    expect(seen[0]).toMatchObject({ kind: "score", score: 65, previousScore: 0, becameHot: true });

    // Same state again: nothing new.
    await mirrorAiState("c1");
    expect(db.rows("crmActivity")).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });
});
