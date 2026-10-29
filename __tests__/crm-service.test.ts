/**
 * ETAP 5 — the route façade: zod rules of the request bodies, the
 * permission guard (VIEWER → 403 on every write, MANAGER+ for broadcasts and
 * configuration, OPERATOR for contact-level writes), and the compositions
 * (contact patch / note / overview) against the in-memory database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: vi.fn() }));
vi.mock("@/lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
// Not importOriginal: the real module pulls next-auth, which vitest cannot resolve.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
  canManageBilling: (role: string) => role === "OWNER",
  hasWorkspaceRole: () => true,
}));
vi.mock("@/lib/crm/broadcast-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm/broadcast-queue")>()),
  enqueueBroadcastStart: vi.fn(),
  enqueueBroadcastBatch: vi.fn(),
  removeBroadcastJobs: vi.fn().mockResolvedValue(0),
}));

import { parseBody, requireCrm } from "@/lib/developer/crm-guard";
import {
  addNote,
  broadcastInputSchema,
  contactPatchSchema,
  contactsQuerySchema,
  getContactDetail,
  getOverview,
  moveDealSchema,
  noteSchema,
  patchContact,
  resolveListWhere,
  run,
  segmentPreviewSchema,
  stagesSchema,
} from "@/lib/crm/service";
import { CrmServiceError } from "@/lib/crm/errors";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];
const WS = "ws1";

function ctx(role: string) {
  return { userId: "u1", workspaceId: WS, workspace: { id: WS }, role };
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  mocks.developerSession.mockResolvedValue({ email: "dev@example.com" });
  db.seed("workspace", { id: WS, name: "Test", ownerId: "u1", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "178", username: "shop", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("workspaceMember", { id: "m_owner", workspaceId: WS, userId: "u1", role: "OWNER" });
  db.seed("crmContact", {
    id: "c1",
    workspaceId: WS,
    instagramAccountId: "acc1",
    igUserId: "ig1",
    username: "ali",
    name: null,
    status: "NEW",
    score: 0,
    temperature: "COLD",
    hasAiState: false,
    customFields: {},
    optedOutAt: null,
    mergedIntoId: null,
    assignedMemberId: null,
    lastInboundAt: new Date(),
  });
});

describe("requireCrm (permission guard)", () => {
  async function status(role: string, permission: Parameters<typeof requireCrm>[0], write = false) {
    mocks.workspaceContext.mockResolvedValue(ctx(role));
    const auth = await requireCrm(permission, { write });
    return auth.ok ? 200 : auth.response.status;
  }

  it("answers 401 without an app session, whatever the developer login says", async () => {
    mocks.developerSession.mockResolvedValueOnce(null);
    expect(await status("OWNER", "view_contacts")).toBe(200);
    mocks.workspaceContext.mockResolvedValueOnce(null);
    const auth = await requireCrm("view_contacts");
    expect(auth.ok ? 200 : auth.response.status).toBe(401);
  });

  it("VIEWER reads but gets 403 on every write; MEMBER is an OPERATOR", async () => {
    expect(await status("VIEWER", "view_contacts")).toBe(200);
    expect(await status("VIEWER", "view_contacts", true)).toBe(403);
    expect(await status("VIEWER", "assign_leads", true)).toBe(403);
    expect(await status("VIEWER", "export_data")).toBe(403);
    expect(await status("VIEWER", "manage_campaigns", true)).toBe(403);
    expect(await status("MEMBER", "assign_leads", true)).toBe(200);
    expect(await status("MEMBER", "export_data")).toBe(403);
  });

  it("OPERATOR may work contacts but not configuration / broadcasts / exports; MANAGER may", async () => {
    expect(await status("OPERATOR", "assign_leads", true)).toBe(200);
    expect(await status("OPERATOR", "manage_campaigns", true)).toBe(403);
    expect(await status("OPERATOR", "export_data")).toBe(403);
    expect(await status("MANAGER", "manage_campaigns", true)).toBe(200);
    expect(await status("MANAGER", "export_data")).toBe(200);
    expect(await status("MANAGER", "manage_instagram")).toBe(403);
    expect(await status("ADMIN", "manage_campaigns", true)).toBe(200);
    expect(await status("OWNER", "manage_billing")).toBe(200);
  });

  it("an unknown role is treated as VIEWER", async () => {
    expect(await status("SOMETHING", "assign_leads", true)).toBe(403);
    expect(await status("SOMETHING", "view_contacts")).toBe(200);
  });
});

describe("zod rules", () => {
  it("parseBody: missing body → 400, invalid → 400 with the first issue, valid → data", () => {
    expect(parseBody(noteSchema, null)).toMatchObject({ ok: false, status: 400 });
    const bad = parseBody(noteSchema, { body: "" });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    if (!bad.ok) expect(bad.error).toContain("Eslatma");
    expect(parseBody(noteSchema, { body: " salom " })).toEqual({ ok: true, data: { body: "salom" } });
  });

  it("contactPatchSchema: at least one field, valid custom keys, email format", () => {
    expect(contactPatchSchema.safeParse({}).success).toBe(false);
    expect(contactPatchSchema.safeParse({ status: "HOT" }).success).toBe(false);
    expect(contactPatchSchema.safeParse({ status: "ACTIVE" }).success).toBe(true);
    expect(contactPatchSchema.safeParse({ customFields: { "1bad": "x" } }).success).toBe(false);
    expect(contactPatchSchema.safeParse({ customFields: { city: "Toshkent", vip: true, age: 3, old: null } }).success).toBe(true);
    expect(contactPatchSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(contactPatchSchema.safeParse({ email: "a@b.co", optedOut: true }).success).toBe(true);
  });

  it("broadcastInputSchema / moveDealSchema / stagesSchema / segmentPreviewSchema", () => {
    expect(broadcastInputSchema.safeParse({ name: "", instagramAccountId: "a", message: "x" }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ name: "A", instagramAccountId: "a", message: "x", scheduledAt: "2026-10-20T10:00:00+05:00" }).success).toBe(true);
    expect(broadcastInputSchema.safeParse({ name: "A", instagramAccountId: "a", message: "x", scheduledAt: "tomorrow" }).success).toBe(false);
    expect(moveDealSchema.safeParse({ stageId: "" }).success).toBe(false);
    expect(moveDealSchema.safeParse({ stageId: "s1", lostReason: "qimmat" }).success).toBe(true);
    expect(stagesSchema.safeParse({ stages: [] }).success).toBe(false);
    expect(stagesSchema.safeParse({ stages: [{ name: "Yangi", isEntry: true, color: "#3B82F6" }] }).success).toBe(true);
    expect(stagesSchema.safeParse({ stages: [{ name: "Yangi", color: "blue" }] }).success).toBe(false);
    expect(segmentPreviewSchema.safeParse({ filter: { v: 1, all: [{ field: "nope", op: "eq", value: 1 }] } }).success).toBe(false);
    expect(segmentPreviewSchema.safeParse({ filter: { v: 1, all: [{ field: "phone_present", op: "is_true" }] } }).success).toBe(true);
  });

  it("contactsQuerySchema coerces the limit from the query string", () => {
    const parsed = contactsQuerySchema.safeParse({ q: "ali", limit: "20", orderBy: "score" });
    expect(parsed.success && parsed.data.limit).toBe(20);
    expect(contactsQuerySchema.safeParse({ orderBy: "name" }).success).toBe(false);
  });

  it("resolveListWhere: segment of another workspace → 404, bad filter JSON → 400, DSL → where", async () => {
    db.seed("crmSegment", { id: "seg1", workspaceId: "other", name: "X", filter: { v: 1, all: [] } });
    expect(await resolveListWhere(WS, { segmentId: "seg1" })).toMatchObject({ ok: false, status: 404 });
    expect(await resolveListWhere(WS, { filter: "{nope" })).toMatchObject({ ok: false, status: 400 });
    expect(await resolveListWhere(WS, { filter: JSON.stringify({ v: 1, all: [{ field: "tag", op: "eq" }] }) })).toMatchObject({ ok: false, status: 400 });
    const ok = await resolveListWhere(WS, { filter: JSON.stringify({ v: 1, all: [{ field: "phone_present", op: "is_true" }] }) });
    expect(ok).toEqual({ ok: true, data: { AND: [{ phoneE164: { not: null } }] } });
    expect(await resolveListWhere(WS, {})).toEqual({ ok: true, data: null });
  });
});

describe("run (thrown CrmServiceError → result)", () => {
  it("maps status + message, and unknown errors to 500", async () => {
    expect(await run(async () => 1)).toEqual({ ok: true, data: 1 });
    expect(
      await run(async () => {
        throw new CrmServiceError(422, "Yaroqsiz");
      })
    ).toEqual({ ok: false, status: 422, error: "Yaroqsiz" });
    expect(
      await run(async () => {
        throw new Error("boom");
      })
    ).toMatchObject({ ok: false, status: 500 });
  });
});

describe("contact compositions", () => {
  const actor = { kind: "OPERATOR" as const, memberId: "m_owner" };

  it("patchContact merges custom fields, changes status with an activity, opts out / in; foreign id → 404", async () => {
    expect(await patchContact(WS, "nope", { status: "ACTIVE" }, actor)).toMatchObject({ ok: false, status: 404 });

    const a = await patchContact(WS, "c1", { status: "ACTIVE", customFields: { city: "Toshkent", course: "IELTS" } }, actor);
    expect(a.ok && a.data.status).toBe("ACTIVE");
    expect(a.ok && a.data.customFields).toEqual({ city: "Toshkent", course: "IELTS" });

    const b = await patchContact(WS, "c1", { customFields: { course: null, vip: true } }, actor);
    expect(b.ok && b.data.customFields).toEqual({ city: "Toshkent", vip: true });

    const c = await patchContact(WS, "c1", { optedOut: true }, actor);
    expect(c.ok && c.data.optedOutAt).toBeInstanceOf(Date);
    expect(c.ok && c.data.optOutReason).toBe("manual");
    const d = await patchContact(WS, "c1", { optedOut: false }, actor);
    expect(d.ok && d.data.optedOutAt).toBeNull();

    const types = rows("crmActivity").map((r) => r.type);
    expect(types).toContain("FIELD_CHANGED");
    expect(types).toContain("OPT_OUT");
  });

  it("addNote writes a NOTE activity that shows up in the contact detail timeline", async () => {
    const note = await addNote(WS, "c1", "Ertaga qo'ng'iroq", actor);
    expect(note.ok).toBe(true);
    expect(await addNote(WS, "ghost", "x", actor)).toMatchObject({ ok: false, status: 404 });
    const detail = await getContactDetail(WS, "c1");
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.contact.id).toBe("c1");
    expect(detail.data.accountUsername).toBe("shop");
    expect(detail.data.timeline.items.some((i) => i.type === "NOTE" && i.body === "Ertaga qo'ng'iroq")).toBe(true);
    expect(await getContactDetail("other", "c1")).toMatchObject({ ok: false, status: 404 });
  });

  it("getOverview counts contacts, phones, unassigned, today's inbound and the open window", async () => {
    db.seed("crmContact", {
      id: "c2",
      workspaceId: WS,
      instagramAccountId: "acc1",
      igUserId: "ig2",
      status: "ACTIVE",
      score: 80,
      temperature: "HOT",
      hasAiState: true,
      phoneE164: "+998901234567",
      assignedMemberId: "m_owner",
      lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      optedOutAt: null,
      mergedIntoId: null,
      customFields: {},
    });
    const overview = await getOverview(WS);
    expect(overview.contacts).toBe(2);
    expect(overview.withPhone).toBe(1);
    expect(overview.withAiState).toBe(1);
    expect(overview.unassigned).toBe(1);
    expect(overview.inboundToday).toBe(1);
    expect(overview.windowOpen).toBe(1);
    expect(overview.byStatus.find((s) => s.status === "ACTIVE")?.count).toBe(1);
    expect(overview.byTemperature.find((t) => t.temperature === "HOT")?.count).toBe(1);
    expect(overview.broadcasts).toEqual({ running: 0, scheduled: 0 });
  });
});
