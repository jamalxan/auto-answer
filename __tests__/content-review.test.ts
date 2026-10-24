/**
 * ETAP 13 Faza 2 — the approval flow (FR-A1…A5): submit with members and
 * external emails, ANY / ALL / OPTIONAL, one rejection stops (comment
 * required), approval schedules, the external token (hash only, 7 days),
 * edit resets the review (FR-A3), the 3-hour grace (FR-A4), Telegram
 * buttons, notes, tenant isolation.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<{ message_id: number }>>(async () => ({ message_id: 1 })),
  sendEmail: vi.fn<(input: { to: string; subject: string; text: string }) => Promise<void>>(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({
  schedulePrepare: mocks.schedulePrepare,
  schedulePublish: mocks.schedulePublish,
  scheduleManualNotify: mocks.scheduleManualNotify,
  removePostJobs: mocks.removePostJobs,
  enqueueMediaProcess: vi.fn(),
}));
vi.mock("@/lib/content/quota", () => ({
  accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
  quotaWindowFull: () => false,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));
vi.mock("@/lib/telegram/api", () => ({ isTelegramConfigured: () => true, sendMessage: mocks.sendMessage, esc: (v: string) => v }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));

import { handleContentCallback } from "@/lib/content/manual";
import {
  addNote,
  decide,
  decideByToken,
  getReviewByToken,
  getReviewSummary,
  hashReviewToken,
  listNotes,
  listReviews,
  newReviewToken,
  reviewerCandidates,
  submitForReview,
  sweepReviews,
} from "@/lib/content/review";
import { createPost, updatePost } from "@/lib/content/service";

const WS = "ws1";
const NOW = new Date("2026-10-24T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function member(userId: string, role: string, ws = WS) {
  db.seed("user", { id: userId, name: `User ${userId}`, email: `${userId}@x.uz` });
  db.seed("workspaceMember", { workspaceId: ws, userId, role });
}

beforeEach(() => {
  resetDb();
  vi.useRealTimers();
  for (const m of Object.values(mocks)) m.mockClear();
  db.seed("workspace", { id: WS, name: "W", ownerId: "owner", timezone: "Asia/Tashkent" });
  db.seed("workspace", { id: "ws2", name: "Other", ownerId: "x" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
  member("op", "OPERATOR");
  member("mgr", "MANAGER");
  member("adm", "ADMIN");
  member("view", "VIEWER");
  member("stranger", "MANAGER", "ws2");
});

const draft = () => createPost(WS, "op", { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }] });
type SubmitInput = Parameters<typeof submitForReview>[3];
const submit = async (over: Partial<SubmitInput> = {}) => {
  const p = await draft();
  const post = await submitForReview(WS, p.id, "op", { reviewerUserIds: ["mgr"], externalEmails: [], rule: "ANY", scheduledAt: at(120), ...over }, { now: NOW });
  return post;
};
const reviews = () => db.rows("postReview");
const postRow = () => db.rows("scheduledPost")[0];
const tokenOf = () => {
  const call = mocks.sendEmail.mock.calls.at(-1)?.[0];
  return /review\/([A-Za-z0-9_-]+)/.exec(call?.text ?? "")?.[1] ?? "";
};

describe("token", () => {
  it("is 32 random bytes in base64url, stored only as its SHA-256", () => {
    const { token, hash } = newReviewToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashReviewToken(token)).toBe(hash);
    expect(newReviewToken().token).not.toBe(token);
  });
});

describe("submitForReview", () => {
  it("moves the post to PENDING_REVIEW, keeps the requested slot, writes one row per reviewer", async () => {
    const post = await submit({ externalEmails: ["Client@Mail.uz"], rule: "ALL" });
    expect(post.status).toBe("PENDING_REVIEW");
    expect(new Date(post.scheduledAt!).toISOString()).toBe(at(120).toISOString());
    expect(postRow().reviewRule).toBe("ALL");
    expect(postRow().reviewSubmittedAt).toBeInstanceOf(Date);
    expect(reviews()).toHaveLength(2);
    expect(reviews().every((r) => r.postVersion === postRow().version)).toBe(true);
    const ext = reviews().find((r) => r.externalEmail)!;
    expect(ext.externalEmail).toBe("client@mail.uz");
    expect(ext.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token only travels in the email.
    const token = tokenOf();
    expect(token).not.toBe("");
    expect(hashReviewToken(token)).toBe(ext.tokenHash);
    expect(JSON.stringify(reviews())).not.toContain(token);
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
    expect(db.rows("operationalEvent").some((e) => String(e.message).includes("submitted for review"))).toBe(true);
  });

  it("refuses reviewers without content.approve or from another workspace, and an empty list", async () => {
    const p = await draft();
    const base = { externalEmails: [], rule: "ANY" as const, scheduledAt: at(120) };
    await expect(submitForReview(WS, p.id, "op", { ...base, reviewerUserIds: ["op"] }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(submitForReview(WS, p.id, "op", { ...base, reviewerUserIds: ["stranger"] }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(submitForReview(WS, p.id, "op", { ...base, reviewerUserIds: [] }, { now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  it("needs the five-minute lead and a publishable post", async () => {
    const p = await draft();
    await expect(submitForReview(WS, p.id, "op", { reviewerUserIds: ["mgr"], externalEmails: [], rule: "ANY", scheduledAt: at(2) }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    const empty = await createPost(WS, "op", { instagramAccountId: "acc1", type: "FEED_IMAGE", media: [] });
    await expect(submitForReview(WS, empty.id, "op", { reviewerUserIds: ["mgr"], externalEmails: [], rule: "ANY", scheduledAt: at(120) }, { now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  it("answers 404 for a post of another workspace", async () => {
    const p = await draft();
    await expect(submitForReview("ws2", p.id, "stranger", { reviewerUserIds: ["stranger"], externalEmails: [], rule: "ANY", scheduledAt: at(120) }, { now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  it("sends linked member reviewers Telegram buttons", async () => {
    db.seed("telegramUser", { tgUserId: "777", userId: "mgr", workspaceId: WS });
    await submit();
    const call = mocks.sendMessage.mock.calls.find((c) => c[0] === "777");
    expect(call).toBeTruthy();
    const keyboard = JSON.stringify((call![2] as { keyboard: unknown }).keyboard);
    const reviewId = reviews()[0].id;
    expect(keyboard).toContain(`content:approve:${reviewId}`);
    expect(keyboard).toContain(`content:reject:${reviewId}`);
  });
});

describe("decide — rules", () => {
  it("ANY: one approval schedules at the requested time", async () => {
    const p = await submit({ reviewerUserIds: ["mgr", "adm"] });
    const after = await decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: NOW });
    expect(after.status).toBe("SCHEDULED");
    expect(new Date(after.scheduledAt!).toISOString()).toBe(at(120).toISOString());
    expect(mocks.schedulePublish).toHaveBeenCalled();
    expect(reviews().find((r) => r.reviewerUserId === "mgr")!.decision).toBe("APPROVED");
  });

  it("ALL: waits for every reviewer", async () => {
    const p = await submit({ reviewerUserIds: ["mgr", "adm"], rule: "ALL" });
    const first = await decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: NOW });
    expect(first.status).toBe("PENDING_REVIEW");
    await expect(decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 409 });
    const second = await decide(WS, p.id, "adm", "ADMIN", { decision: "APPROVED" }, { now: NOW });
    expect(second.status).toBe("SCHEDULED");
  });

  it("one rejection stops everything and needs a comment (FR-A5)", async () => {
    const p = await submit({ reviewerUserIds: ["mgr", "adm"], rule: "ALL" });
    await expect(decide(WS, p.id, "mgr", "MANAGER", { decision: "REJECTED" }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(decide(WS, p.id, "mgr", "MANAGER", { decision: "REJECTED", comment: "   " }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    const r = await decide(WS, p.id, "mgr", "MANAGER", { decision: "REJECTED", comment: "Rasm xira" }, { now: NOW });
    expect(r.status).toBe("REJECTED");
    expect(reviews().find((x) => x.reviewerUserId === "mgr")!.comment).toBe("Rasm xira");
    await expect(decide(WS, p.id, "adm", "ADMIN", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 409 });
  });

  it("a slot already in the past (or within 5 min) is published a minute from now", async () => {
    const p = await submit();
    const late = new Date(at(120).getTime() + 60 * 60_000);
    const after = await decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: late });
    expect(new Date(after.scheduledAt!).toISOString()).toBe(new Date(late.getTime() + 60_000).toISOString());
  });

  it("OPERATOR and VIEWER cannot decide; an unassigned approver's decision is final", async () => {
    const p = await submit({ reviewerUserIds: ["mgr"], rule: "ALL" });
    await expect(decide(WS, p.id, "op", "OPERATOR", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 403 });
    await expect(decide(WS, p.id, "view", "VIEWER", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 403 });
    const after = await decide(WS, p.id, "adm", "ADMIN", { decision: "APPROVED" }, { now: NOW });
    expect(after.status).toBe("SCHEDULED");
  });

  it("another workspace gets 404", async () => {
    const p = await submit();
    await expect(decide("ws2", p.id, "stranger", "MANAGER", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 404 });
  });
});

describe("external reviewer token", () => {
  it("previews and approves by token; expired, unknown or reused tokens fail", async () => {
    const p = await submit({ reviewerUserIds: [], externalEmails: ["client@mail.uz"] });
    const token = tokenOf();
    const view = await getReviewByToken(token, NOW);
    expect(view.state).toBe("open");
    expect(view.post.caption).toBe("Salom");
    expect(view.post.accountUsername).toBe("jamalxann");
    await expect(getReviewByToken("nope", NOW)).rejects.toMatchObject({ status: 404 });
    await expect(getReviewByToken(token, new Date(NOW.getTime() + 8 * 24 * 3_600_000))).rejects.toMatchObject({ status: 404 });
    await expect(decideByToken(token, { decision: "REJECTED" }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    const r = await decideByToken(token, { decision: "APPROVED" }, { now: NOW });
    expect(r.state).toBe("decided");
    expect(db.rows("scheduledPost").find((x) => x.id === p.id)!.status).toBe("SCHEDULED");
    await expect(decideByToken(token, { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 409 });
  });

  it("an edited post invalidates the old link (FR-A3)", async () => {
    const p = await submit({ reviewerUserIds: [], externalEmails: ["client@mail.uz"] });
    const token = tokenOf();
    await updatePost(WS, p.id, { caption: "Yangi", version: postRow().version as number });
    await expect(getReviewByToken(token, NOW)).rejects.toMatchObject({ status: 404 });
  });
});

describe("FR-A3: edit resets the review", () => {
  it("PENDING_REVIEW → DRAFT, the old round no longer counts", async () => {
    const p = await submit();
    const edited = await updatePost(WS, p.id, { caption: "Yangi", version: postRow().version as number });
    expect(edited.status).toBe("DRAFT");
    expect(postRow().reviewSubmittedAt).toBeNull();
    await expect(decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: NOW })).rejects.toMatchObject({ status: 409 });
    const summary = await getReviewSummary(WS, p.id);
    expect(summary.reviews.every((r) => !r.current)).toBe(true);
  });

  it("an approved, scheduled post goes back to DRAFT and its jobs are removed", async () => {
    const p = await submit();
    await decide(WS, p.id, "mgr", "MANAGER", { decision: "APPROVED" }, { now: NOW });
    mocks.removePostJobs.mockClear();
    const edited = await updatePost(WS, p.id, { caption: "Yangi", version: postRow().version as number });
    expect(edited.status).toBe("DRAFT");
    expect(mocks.removePostJobs).toHaveBeenCalled();
  });

  it("a post that never went through review keeps its schedule on edit", async () => {
    const p = await draft();
    const { schedulePost } = await import("@/lib/content/service");
    await schedulePost(WS, p.id, at(120), { now: NOW });
    const edited = await updatePost(WS, p.id, { caption: "Yangi", version: postRow().version as number });
    expect(edited.status).toBe("SCHEDULED");
  });

  it("a rejected post can be resubmitted as a new round", async () => {
    const p = await submit();
    await decide(WS, p.id, "mgr", "MANAGER", { decision: "REJECTED", comment: "Yo'q" }, { now: NOW });
    const again = await submitForReview(WS, p.id, "op", { reviewerUserIds: ["mgr"], externalEmails: [], rule: "ANY", scheduledAt: at(180) }, { now: NOW });
    expect(again.status).toBe("PENDING_REVIEW");
    const summary = await getReviewSummary(WS, p.id);
    expect(summary.reviews.filter((r) => r.current)).toHaveLength(1);
    expect(summary.reviews).toHaveLength(2);
  });
});

describe("FR-A4: sweepReviews", () => {
  it("expires a pending post 3 hours after its slot and notifies the owner", async () => {
    const p = await submit();
    mocks.sendEmail.mockClear();
    const r1 = await sweepReviews(new Date(at(120).getTime() + 2 * 3_600_000));
    expect(r1.expired).toBe(0);
    const r2 = await sweepReviews(new Date(at(120).getTime() + 3 * 3_600_000 + 60_000));
    expect(r2.expired).toBe(1);
    expect(db.rows("scheduledPost").find((x) => x.id === p.id)!.status).toBe("EXPIRED_REVIEW");
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "op@x.uz" }));
  });

  it("OPTIONAL: nobody objected by the slot → approved and scheduled", async () => {
    const p = await submit({ rule: "OPTIONAL" });
    const early = await sweepReviews(at(60));
    expect(early.autoApproved).toBe(0);
    const r = await sweepReviews(at(120));
    expect(r.autoApproved).toBe(1);
    const row = db.rows("scheduledPost").find((x) => x.id === p.id)!;
    expect(row.status).toBe("SCHEDULED");
    expect((row.scheduledAt as Date).toISOString()).toBe(at(121).toISOString());
  });
});

describe("Telegram buttons (content:approve / content:reject)", () => {
  it("the linked reviewer approves from Telegram; reject asks for the app", async () => {
    db.seed("telegramUser", { tgUserId: "777", userId: "mgr", workspaceId: WS });
    db.seed("telegramUser", { tgUserId: "888", userId: "op", workspaceId: WS });
    const p = await submit();
    const reviewId = reviews()[0].id as string;
    expect(await handleContentCallback(`content:approve:${reviewId}`, { tgUserId: "888" })).toMatch(/ruxsat/i);
    expect(await handleContentCallback(`content:reject:${reviewId}`, { tgUserId: "777" })).toMatch(/izoh/i);
    expect(postRow().status).toBe("PENDING_REVIEW");
    expect(await handleContentCallback(`content:approve:${reviewId}`, { tgUserId: "777" })).toMatch(/tasdiqlandi/i);
    expect(db.rows("scheduledPost").find((x) => x.id === p.id)!.status).toBe("SCHEDULED");
    expect(await handleContentCallback(`content:approve:${reviewId}`, { tgUserId: "777" })).not.toMatch(/tasdiqlandi/i);
  });
});

describe("lists, notes, candidates", () => {
  it("mine / sent / rejected tabs", async () => {
    const p = await submit({ reviewerUserIds: ["mgr"] });
    expect((await listReviews(WS, "mgr", "mine")).map((i) => i.id)).toEqual([p.id]);
    expect((await listReviews(WS, "adm", "mine"))).toEqual([]);
    expect((await listReviews(WS, "op", "sent")).map((i) => i.id)).toEqual([p.id]);
    expect((await listReviews("ws2", "stranger", "sent"))).toEqual([]);
    await decide(WS, p.id, "mgr", "MANAGER", { decision: "REJECTED", comment: "Yo'q" }, { now: NOW });
    expect((await listReviews(WS, "mgr", "mine"))).toEqual([]);
    const rejected = await listReviews(WS, "adm", "rejected");
    expect(rejected.map((i) => i.id)).toEqual([p.id]);
    expect(rejected[0].reviews[0].comment).toBe("Yo'q");
  });

  it("notes belong to the post's workspace and carry the author", async () => {
    const p = await draft();
    await addNote(WS, p.id, "op", "  Rasmni almashtiring  ");
    const notes = await listNotes(WS, p.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ body: "Rasmni almashtiring", authorId: "op", authorLabel: "User op" });
    await expect(addNote("ws2", p.id, "stranger", "x")).rejects.toMatchObject({ status: 404 });
    await expect(listNotes("ws2", p.id)).rejects.toMatchObject({ status: 404 });
    await expect(addNote(WS, p.id, "op", "   ")).rejects.toMatchObject({ status: 400 });
  });

  it("reviewer candidates are the workspace's approvers", async () => {
    const list = await reviewerCandidates(WS);
    expect(list.map((c) => c.userId).sort()).toEqual(["adm", "mgr"]);
  });
});
