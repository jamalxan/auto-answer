/**
 * ETAP 13 Faza 2 — the approval flow (spec §5.7, FR-A1…A5) and post notes.
 *
 *   submit    OPERATOR+ sends a publishable DRAFT (or a REJECTED / EXPIRED
 *             one) to workspace approvers and / or external emails with a
 *             rule. The requested slot is kept in `scheduledAt` while the
 *             post is PENDING_REVIEW. One PostReview row per reviewer, all
 *             stamped with the post's version: that is the "round".
 *   decide    a member (content.approve) or an external reviewer (token).
 *             A rejection needs a comment and always stops (→ REJECTED).
 *             ANY / OPTIONAL: the first approval schedules; ALL: every
 *             assigned reviewer must approve. An approver who was not
 *             assigned decides alone (an override — they could schedule it
 *             themselves anyway).
 *   schedule  through service.schedulePost at the requested time; a slot in
 *             the past or under five minutes away goes out a minute from now.
 *   reset     FR-A3 lives in service.updatePost: an edit sends the post back
 *             to DRAFT and bumps its version, so the old round stops counting.
 *   sweep     FR-A4: OPTIONAL posts nobody rejected are approved at their
 *             slot; any PENDING_REVIEW post 3 h past its slot → EXPIRED_REVIEW.
 *
 * External tokens: 32 random bytes (base64url) mailed once; only the SHA-256
 * is stored; valid 7 days from the round's creation. Every decision is
 * audited to OperationalEvent. Decisions do not bump the post version — the
 * version only moves when the post itself changes.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { sendEmail } from "@/lib/email";
import { getBaseUrl } from "@/lib/env";
import { esc, isTelegramConfigured, sendMessage, type InlineKeyboard } from "@/lib/telegram/api";
import { canContent } from "./permissions";
import { ContentError, notFound } from "./errors";
import { signedMediaUrl } from "./media";
import { scheduleInputSchema, type PostStatusValue, type PostTypeValue } from "./schema";
import { getPost, issuesOfRow, loadRow, schedulePost, type PostDetail } from "./service";
import { formatZoned } from "./time";
import { scheduleIssues } from "./validate";

export const REVIEW_TOKEN_TTL_MS = 7 * 24 * 3_600_000;
/** FR-A4: how long past its slot a post may wait for a decision. */
export const REVIEW_GRACE_MS = 3 * 3_600_000;
const MIN_LEAD_MS = 5 * 60_000;
const MAX_REVIEWERS = 20;
const MAX_EXTERNAL = 10;
const BATCH = 200;

export type ReviewRuleValue = "ANY" | "ALL" | "OPTIONAL";
export type ReviewDecision = "APPROVED" | "REJECTED";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const reviewSubmitSchema = z.object({
  reviewerUserIds: z.array(z.string().min(1)).max(MAX_REVIEWERS).default([]),
  externalEmails: z.array(z.string().trim().toLowerCase().email("email noto'g'ri")).max(MAX_EXTERNAL, `${MAX_EXTERNAL} tadan ko'p tashqi reviewer bo'lmaydi`).default([]),
  rule: z.enum(["ANY", "ALL", "OPTIONAL"]).default("ANY"),
  scheduledAt: scheduleInputSchema.shape.scheduledAt,
});

export const reviewDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().max(2000, "izoh 2000 belgidan oshmasin").optional(),
});
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;

export const noteInputSchema = z.object({ body: z.string().max(2000, "izoh 2000 belgidan oshmasin") });

export const reviewsQuerySchema = z.object({ tab: z.enum(["mine", "sent", "rejected"]).default("mine") });
export type ReviewsTab = z.infer<typeof reviewsQuerySchema>["tab"];

// ─── Token ──────────────────────────────────────────────────────────────────

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newReviewToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashReviewToken(token) };
}

export function reviewLink(token: string): string {
  return `${getBaseUrl().replace(/\/+$/, "")}/review/${token}`;
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface ReviewView {
  id: string;
  reviewerUserId: string | null;
  reviewerLabel: string;
  externalEmail: string | null;
  decision: ReviewDecision | null;
  comment: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  /** Part of the live round (false: an older round voided by an edit or a resubmit). */
  current: boolean;
}

export interface ReviewSummary {
  rule: ReviewRuleValue | null;
  submittedAt: Date | null;
  status: PostStatusValue;
  reviews: ReviewView[];
}

export interface ReviewListItem {
  id: string;
  type: PostTypeValue;
  status: PostStatusValue;
  accountUsername: string | null;
  caption: string | null;
  scheduledAt: Date | null;
  timezone: string;
  thumbUrl: string | null;
  rule: ReviewRuleValue | null;
  submittedAt: Date | null;
  version: number;
  reviews: ReviewView[];
  /** The caller's own undecided review in the live round. */
  myReviewId: string | null;
}

export interface ExternalReviewView {
  email: string | null;
  decision: ReviewDecision | null;
  comment: string | null;
  /** open: buttons; decided: this reviewer answered; closed: the post moved on without them. */
  state: "open" | "decided" | "closed";
  expiresAt: Date;
  post: {
    type: PostTypeValue;
    status: PostStatusValue;
    accountUsername: string | null;
    caption: string | null;
    firstComment: string | null;
    scheduledAt: Date | null;
    timezone: string;
    media: Array<{ kind: string; thumbUrl: string | null; previewUrl: string | null }>;
  };
}

export interface ReviewerCandidate {
  userId: string;
  label: string;
  email: string | null;
  role: string;
  telegram: boolean;
}

type ReviewRow = { id: string; postId: string; reviewerUserId: string | null; externalEmail: string | null; tokenHash: string | null; decision: string | null; comment: string | null; postVersion: number; decidedAt: Date | null; createdAt: Date };

interface DecideOptions {
  now?: Date;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = { FEED_IMAGE: "Post", FEED_VIDEO: "Video", CAROUSEL: "Karusel", REEL: "Reels", TRIAL_REEL: "Trial Reels", STORY: "Story" };

function userLabel(user: { name: string | null; email: string | null } | null | undefined, fallback: string): string {
  return user?.name?.trim() || user?.email || fallback;
}

async function userLabels(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((u) => [u.id, userLabel(u, u.id)]));
}

async function viewsOf(rows: ReviewRow[], currentVersion: number | null): Promise<ReviewView[]> {
  const labels = await userLabels(rows.map((r) => r.reviewerUserId).filter((v): v is string => Boolean(v)));
  return rows.map((r) => ({
    id: r.id,
    reviewerUserId: r.reviewerUserId,
    reviewerLabel: r.reviewerUserId ? (labels.get(r.reviewerUserId) ?? r.reviewerUserId) : (r.externalEmail ?? "—"),
    externalEmail: r.externalEmail,
    decision: (r.decision as ReviewDecision | null) ?? null,
    comment: r.comment,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
    current: currentVersion !== null && r.postVersion === currentVersion,
  }));
}

/** The version of the live round, or null when the post is not (or no longer) in one. */
function liveRound(post: { reviewSubmittedAt: Date | null }, rows: Array<{ postVersion: number }>): number | null {
  if (!post.reviewSubmittedAt || rows.length === 0) return null;
  return Math.max(...rows.map((r) => r.postVersion));
}

async function audit(workspaceId: string, message: string, payload: Record<string, unknown>): Promise<void> {
  await prisma.operationalEvent.create({ data: { workspaceId, source: "SYSTEM", level: "INFO", message, payload: payload as never } }).catch(() => undefined);
}

/** Telegram when the user linked the bot to this workspace, otherwise email. Best effort. */
async function notifyUser(workspaceId: string, userId: string | null, subject: string, html: string, plain: string): Promise<void> {
  if (!userId) return;
  try {
    const link = isTelegramConfigured() ? await prisma.telegramUser.findFirst({ where: { userId, workspaceId }, select: { tgUserId: true } }) : null;
    if (link) {
      await sendMessage(link.tgUserId, html);
      return;
    }
  } catch (error) {
    console.error("[Content] review notice (Telegram) failed:", error instanceof Error ? error.message : error);
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user?.email) await sendEmail({ to: user.email, subject, text: plain });
  } catch (error) {
    console.error("[Content] review notice (email) failed:", error instanceof Error ? error.message : error);
  }
}

function postLine(post: { type: string; scheduledAt: Date | null; timezone: string }, username: string | null): string {
  const when = post.scheduledAt ? `, ${formatZoned(post.scheduledAt, post.timezone)}` : "";
  return `${TYPE_LABEL[post.type] ?? post.type} (@${username ?? "—"}${when})`;
}

function appLink(postId: string): string {
  return `${getBaseUrl().replace(/\/+$/, "")}/developer/content?tab=reviews&post=${postId}`;
}

async function notifyOwner(postId: string, kind: "approved" | "rejected" | "expired", comment?: string | null): Promise<void> {
  const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, include: { instagramAccount: { select: { username: true } } } });
  if (!post) return;
  const line = postLine(post, post.instagramAccount?.username ?? null);
  const head = kind === "approved" ? "✅ Post tasdiqlandi va rejalashtirildi" : kind === "rejected" ? "❌ Post rad etildi" : "⌛ Post tasdiqlanmadi — vaqti o'tdi";
  const tail = kind === "rejected" && comment ? `\nIzoh: ${comment}` : kind === "expired" ? "\nVaqtni yangilab qayta tasdiqqa yuboring." : "";
  await notifyUser(post.workspaceId, post.createdById, `${head}: ${line}`, `<b>${esc(head)}</b>\n${esc(line)}${esc(tail)}`, `${head}: ${line}${tail}\n${appLink(postId)}`);
}

// ─── Submit ─────────────────────────────────────────────────────────────────

export interface SubmitInput {
  reviewerUserIds: string[];
  externalEmails: string[];
  rule: ReviewRuleValue;
  scheduledAt: Date;
}

const SUBMITTABLE: PostStatusValue[] = ["DRAFT", "REJECTED", "EXPIRED_REVIEW"];

export async function submitForReview(workspaceId: string, postId: string, userId: string, input: SubmitInput, opts: DecideOptions = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const row = await loadRow(workspaceId, postId);
  if (!SUBMITTABLE.includes(row.status)) throw new ContentError(409, "Faqat draft (yoki rad etilgan) postni tasdiqqa yuborish mumkin");

  const when = scheduleIssues(input.scheduledAt, now);
  if (when.length) throw new ContentError(400, when[0].message);
  const issues = issuesOfRow(row, now);
  if (issues.length) throw new ContentError(400, issues.map((i) => i.message).join("; "));

  const memberIds = [...new Set(input.reviewerUserIds)];
  const emails = [...new Set(input.externalEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (memberIds.length === 0 && emails.length === 0) throw new ContentError(400, "Kamida bitta tasdiqlovchini tanlang");
  if (memberIds.length) {
    const members = await prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: memberIds } }, select: { userId: true, role: true } });
    const ok = new Set(members.filter((m) => canContent(m.role, "content.approve")).map((m) => m.userId));
    if (memberIds.some((id) => !ok.has(id))) throw new ContentError(400, "Tasdiqlovchi topilmadi yoki unda tasdiqlash huquqi yo'q (MANAGER va yuqori)");
  }

  const r = await prisma.scheduledPost.updateMany({
    where: { id: postId, status: row.status, version: row.version },
    data: { status: "PENDING_REVIEW", scheduledAt: input.scheduledAt, reviewRule: input.rule, reviewSubmittedAt: now, version: { increment: 1 } },
  });
  if (r.count === 0) throw new ContentError(409, "Post holati o'zgarib ketdi — sahifani yangilang");
  const postVersion = row.version + 1;

  const memberRows: Array<{ id: string; userId: string }> = [];
  for (const reviewerUserId of memberIds) {
    const created = await prisma.postReview.create({ data: { postId, reviewerUserId, postVersion } });
    memberRows.push({ id: created.id, userId: reviewerUserId });
  }
  const externalRows: Array<{ email: string; token: string }> = [];
  for (const email of emails) {
    const { token, hash } = newReviewToken();
    await prisma.postReview.create({ data: { postId, externalEmail: email, tokenHash: hash, postVersion } });
    externalRows.push({ email, token });
  }

  await audit(workspaceId, `Post ${postId} submitted for review`, { postId, userId, rule: input.rule, reviewers: memberIds, externalCount: emails.length, scheduledAt: input.scheduledAt.toISOString() });
  await notifyReviewers(row.workspaceId, postId, memberRows, externalRows).catch((e) => console.error("[Content] reviewer notice failed:", e instanceof Error ? e.message : e));
  return getPost(workspaceId, postId);
}

function reviewKeyboard(reviewId: string): InlineKeyboard {
  return [[
    { text: "✅ Tasdiqlash", callback_data: `content:approve:${reviewId}` },
    { text: "❌ Rad etish", callback_data: `content:reject:${reviewId}` },
  ]];
}

/** Members with a linked Telegram get buttons; externals get the link by email. */
async function notifyReviewers(workspaceId: string, postId: string, members: Array<{ id: string; userId: string }>, externals: Array<{ email: string; token: string }>): Promise<void> {
  const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, include: { instagramAccount: { select: { username: true } } } });
  if (!post) return;
  const line = postLine(post, post.instagramAccount?.username ?? null);
  const caption = post.caption?.trim() ? `\n\n${post.caption.trim().slice(0, 600)}` : "";

  if (members.length && isTelegramConfigured()) {
    const links = await prisma.telegramUser.findMany({ where: { workspaceId, userId: { in: members.map((m) => m.userId) } }, select: { tgUserId: true, userId: true } });
    for (const m of members) {
      for (const link of links.filter((l) => l.userId === m.userId)) {
        await sendMessage(link.tgUserId, `📝 <b>Tasdiqlash kutilmoqda</b>: ${esc(line)}${esc(caption)}\n\nRad etish uchun izoh kerak — uni ilovada yozasiz: ${esc(appLink(postId))}`, { keyboard: reviewKeyboard(m.id) }).catch((e) =>
          console.error("[Content] reviewer Telegram failed:", e instanceof Error ? e.message : e)
        );
      }
    }
  }
  for (const ext of externals) {
    const url = reviewLink(ext.token);
    await sendEmail({
      to: ext.email,
      subject: `SocialAuto: ${line} tasdiqlashingizni kutmoqda`,
      text: `Assalomu alaykum!\n\n${line} posti chiqishidan oldin tasdiqlashingiz so'raldi.${caption}\n\nKo'rib chiqish: ${url}\n\nHavola 7 kun amal qiladi. Uni boshqalarga yubormang.`,
    }).catch(async (e) => {
      console.error("[Content] reviewer email failed:", e instanceof Error ? e.message : e);
      await prisma.operationalEvent.create({ data: { workspaceId, source: "SYSTEM", level: "WARNING", message: `Review email to an external reviewer failed for post ${postId}`, payload: { postId } } }).catch(() => undefined);
    });
  }
}

// ─── Decide ─────────────────────────────────────────────────────────────────

async function roundOf(postId: string, version: number): Promise<ReviewRow[]> {
  return (await prisma.postReview.findMany({ where: { postId, postVersion: version }, orderBy: { createdAt: "asc" } })) as ReviewRow[];
}

/** When the review is complete: the requested slot, or a minute from now when it is too close or gone. */
async function approveAndSchedule(workspaceId: string, postId: string, requested: Date | null, now: Date): Promise<PostDetail> {
  const keep = requested && requested.getTime() - now.getTime() >= MIN_LEAD_MS;
  const at = keep ? requested : new Date(now.getTime() + 60_000);
  return schedulePost(workspaceId, postId, at, { now, skipLeadCheck: !keep });
}

interface Actor {
  userId: string | null;
  /** The assigned review row this actor answers, or null for an unassigned approver (override). */
  review: ReviewRow | null;
  label: string;
}

async function applyDecision(workspaceId: string, postId: string, actor: Actor, input: ReviewDecisionInput, now: Date): Promise<PostDetail> {
  const post = await loadRow(workspaceId, postId);
  if (post.status !== "PENDING_REVIEW") throw new ContentError(409, "Post tasdiq kutmayapti");
  const round = await roundOf(postId, post.version);
  if (round.length === 0) throw new ContentError(409, "Tasdiq bekor qilingan — post tahrirlangan");
  if (actor.review && actor.review.postVersion !== post.version) throw new ContentError(409, "Bu tasdiq eskirgan — post tahrirlangan");
  if (actor.review?.decision) throw new ContentError(409, "Siz allaqachon qaror bergansiz");

  const comment = input.comment?.trim() || null;
  if (input.decision === "REJECTED" && !comment) throw new ContentError(400, "Rad etishda izoh yozish majburiy");

  // Record the answer (a fresh row for an unassigned approver).
  const row = actor.review
    ? await prisma.postReview.update({ where: { id: actor.review.id }, data: { decision: input.decision, comment, decidedAt: now } })
    : await prisma.postReview.create({ data: { postId, reviewerUserId: actor.userId, postVersion: post.version, decision: input.decision, comment, decidedAt: now } });

  if (input.decision === "REJECTED") {
    const r = await prisma.scheduledPost.updateMany({ where: { id: postId, status: "PENDING_REVIEW", version: post.version }, data: { status: "REJECTED", version: { increment: 1 } } });
    if (r.count === 0) {
      await prisma.postReview.update({ where: { id: row.id }, data: { decision: null, comment: null, decidedAt: null } });
      throw new ContentError(409, "Post holati o'zgarib ketdi — sahifani yangilang");
    }
    await audit(workspaceId, `Post ${postId} rejected`, { postId, userId: actor.userId, reviewer: actor.label, comment });
    await notifyOwner(postId, "rejected", comment);
    return getPost(workspaceId, postId);
  }

  const rule = (post.reviewRule ?? "ANY") as ReviewRuleValue;
  const assigned = round.map((r) => (r.id === row.id ? { ...r, decision: "APPROVED" } : r));
  const complete = !actor.review || rule !== "ALL" || assigned.every((r) => r.decision === "APPROVED");
  await audit(workspaceId, `Post ${postId} approved by a reviewer`, { postId, userId: actor.userId, reviewer: actor.label, rule, complete, override: !actor.review });
  if (!complete) return getPost(workspaceId, postId);

  try {
    const scheduled = await approveAndSchedule(workspaceId, postId, post.scheduledAt, now);
    await audit(workspaceId, `Post ${postId} approved and scheduled`, { postId, scheduledAt: scheduled.scheduledAt });
    await notifyOwner(postId, "approved");
    return scheduled;
  } catch (error) {
    // Scheduling refused (quota, a broken file…): the answer is not recorded, the post keeps waiting.
    if (actor.review) await prisma.postReview.update({ where: { id: row.id }, data: { decision: null, comment: null, decidedAt: null } });
    else await prisma.postReview.delete({ where: { id: row.id } });
    throw error;
  }
}

/** A workspace member decides (route: content.approve). */
export async function decide(workspaceId: string, postId: string, userId: string, role: string, input: ReviewDecisionInput, opts: DecideOptions = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const post = await loadRow(workspaceId, postId);
  if (!canContent(role, "content.approve")) throw new ContentError(403, "Ruxsat yo'q: Postni tasdiqlash");
  const round = await roundOf(post.id, post.version);
  const mine = round.find((r) => r.reviewerUserId === userId) ?? null;
  const labels = await userLabels([userId]);
  return applyDecision(workspaceId, postId, { userId, review: mine, label: labels.get(userId) ?? userId }, input, now);
}

async function reviewByToken(token: string, now: Date) {
  if (!token || token.length > 200) throw notFound();
  const review = (await prisma.postReview.findFirst({ where: { tokenHash: hashReviewToken(token) } })) as ReviewRow | null;
  if (!review || !review.externalEmail) throw notFound();
  if (now.getTime() - review.createdAt.getTime() > REVIEW_TOKEN_TTL_MS) throw notFound();
  const post = await prisma.scheduledPost.findUnique({ where: { id: review.postId }, include: { instagramAccount: { select: { username: true } }, media: { include: { media: true }, orderBy: { position: "asc" } } } });
  if (!post || post.deletedAt) throw notFound();
  // FR-A3: an edit voided this round — the old link must not open the new content.
  const voided = post.status === "PENDING_REVIEW" ? review.postVersion !== post.version : !post.reviewSubmittedAt || post.status === "DRAFT";
  if (voided) throw notFound();
  return { review, post };
}

export async function getReviewByToken(token: string, now: Date = new Date()): Promise<ExternalReviewView> {
  const { review, post } = await reviewByToken(token, now);
  const media = await Promise.all(
    post.media.map(async (m) => ({
      kind: m.media.kind,
      thumbUrl: m.media.thumbKey ? await signedMediaUrl(m.media.thumbKey) : null,
      previewUrl: m.media.preparedKey ? await signedMediaUrl(m.media.preparedKey) : null,
    }))
  );
  return {
    email: review.externalEmail,
    decision: (review.decision as ReviewDecision | null) ?? null,
    comment: review.comment,
    state: review.decision ? "decided" : post.status === "PENDING_REVIEW" ? "open" : "closed",
    expiresAt: new Date(review.createdAt.getTime() + REVIEW_TOKEN_TTL_MS),
    post: {
      type: post.type,
      status: post.status,
      accountUsername: post.instagramAccount?.username ?? null,
      caption: post.caption,
      firstComment: post.firstComment,
      scheduledAt: post.scheduledAt,
      timezone: post.timezone,
      media,
    },
  };
}

/** The external reviewer's answer from /review/[token]. */
export async function decideByToken(token: string, input: ReviewDecisionInput, opts: DecideOptions = {}): Promise<ExternalReviewView> {
  const now = opts.now ?? new Date();
  const { review, post } = await reviewByToken(token, now);
  if (review.decision) throw new ContentError(409, "Siz allaqachon qaror bergansiz");
  if (post.status !== "PENDING_REVIEW") throw new ContentError(409, "Post allaqachon ko'rib chiqilgan");
  await applyDecision(post.workspaceId, post.id, { userId: null, review, label: review.externalEmail ?? "external" }, input, now);
  return getReviewByToken(token, now);
}

// ─── Telegram buttons ───────────────────────────────────────────────────────

/**
 * "content:approve:<reviewId>" / "content:reject:<reviewId>" from the member
 * reviewer's private chat. Only the Telegram user linked to that reviewer
 * (same workspace, still an approver) may press them. Rejecting needs a
 * comment and the bot has no reply flow for it, so "Rad etish" answers with
 * a pointer to the app instead of rejecting silently.
 */
export async function handleReviewCallback(action: "approve" | "reject", reviewId: string, tgUserId: string): Promise<string> {
  const review = (await prisma.postReview.findUnique({ where: { id: reviewId } })) as ReviewRow | null;
  if (!review?.reviewerUserId) return "Tasdiq topilmadi";
  const post = await prisma.scheduledPost.findUnique({ where: { id: review.postId }, select: { id: true, workspaceId: true, deletedAt: true } });
  if (!post || post.deletedAt) return "Post topilmadi";
  const link = await prisma.telegramUser.findUnique({ where: { tgUserId } });
  if (!link || link.userId !== review.reviewerUserId || link.workspaceId !== post.workspaceId) return "Bu amalga ruxsat yo'q";
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: post.workspaceId, userId: link.userId }, select: { role: true } });
  if (!member || !canContent(member.role, "content.approve")) return "Bu amalga ruxsat yo'q";
  if (action === "reject") return "Rad etish uchun izoh majburiy — SocialAuto → Kontent → Tasdiqlar bo'limida rad eting";
  try {
    const after = await decide(post.workspaceId, post.id, link.userId, member.role, { decision: "APPROVED" });
    return after.status === "SCHEDULED" ? "✅ Tasdiqlandi — post rejalashtirildi" : "✅ Tasdiqlandi — boshqa tasdiqlovchilar kutilmoqda";
  } catch (error) {
    return error instanceof ContentError ? error.message : "Xatolik yuz berdi, birozdan keyin qayta urinib ko'ring.";
  }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export async function getReviewSummary(workspaceId: string, postId: string): Promise<ReviewSummary> {
  const post = await loadRow(workspaceId, postId);
  const rows = (await prisma.postReview.findMany({ where: { postId }, orderBy: { createdAt: "asc" } })) as ReviewRow[];
  return {
    rule: (post.reviewRule as ReviewRuleValue | null) ?? null,
    submittedAt: post.reviewSubmittedAt,
    status: post.status,
    reviews: await viewsOf(rows, liveRound(post, rows)),
  };
}

export async function listReviews(workspaceId: string, userId: string, tab: ReviewsTab): Promise<ReviewListItem[]> {
  const where =
    tab === "mine"
      ? { workspaceId, deletedAt: null, status: "PENDING_REVIEW" as const, reviews: { some: { reviewerUserId: userId, decision: null } } }
      : tab === "sent"
        ? { workspaceId, deletedAt: null, createdById: userId, reviewSubmittedAt: { not: null } }
        : { workspaceId, deletedAt: null, status: "REJECTED" as const };
  const posts = await prisma.scheduledPost.findMany({
    where,
    orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }],
    take: BATCH,
    include: {
      instagramAccount: { select: { username: true } },
      media: { include: { media: { select: { thumbKey: true } } }, orderBy: { position: "asc" } },
      reviews: { orderBy: { createdAt: "asc" } },
    },
  });
  const items: ReviewListItem[] = [];
  for (const post of posts) {
    const rows = post.reviews as ReviewRow[];
    const round = liveRound(post, rows);
    const current = rows.filter((r) => r.postVersion === round);
    const myReview = post.status === "PENDING_REVIEW" && round === post.version ? (current.find((r) => r.reviewerUserId === userId && !r.decision) ?? null) : null;
    if (tab === "mine" && !myReview) continue;
    const thumbKey = post.media[0]?.media?.thumbKey;
    items.push({
      id: post.id,
      type: post.type,
      status: post.status,
      accountUsername: post.instagramAccount?.username ?? null,
      caption: post.caption ? post.caption.slice(0, 200) : null,
      scheduledAt: post.scheduledAt,
      timezone: post.timezone,
      thumbUrl: thumbKey ? await signedMediaUrl(thumbKey) : null,
      rule: (post.reviewRule as ReviewRuleValue | null) ?? null,
      submittedAt: post.reviewSubmittedAt,
      version: post.version,
      reviews: await viewsOf(current, round),
      myReviewId: myReview?.id ?? null,
    });
  }
  return items;
}

/** The workspace members who may approve (the composer's reviewer picker). */
export async function reviewerCandidates(workspaceId: string): Promise<ReviewerCandidate[]> {
  const members = await prisma.workspaceMember.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true } } } });
  const approvers = members.filter((m) => canContent(m.role, "content.approve"));
  const links = approvers.length ? await prisma.telegramUser.findMany({ where: { workspaceId, userId: { in: approvers.map((m) => m.userId) } }, select: { userId: true } }) : [];
  const linked = new Set(links.map((l) => l.userId));
  return approvers.map((m) => ({ userId: m.userId, label: userLabel(m.user, m.userId), email: m.user?.email ?? null, role: m.role, telegram: linked.has(m.userId) }));
}

// ─── Notes ──────────────────────────────────────────────────────────────────

export interface NoteView {
  id: string;
  body: string;
  authorId: string;
  authorLabel: string;
  createdAt: Date;
}

export async function listNotes(workspaceId: string, postId: string): Promise<NoteView[]> {
  await loadRow(workspaceId, postId);
  const notes = await prisma.postNote.findMany({ where: { postId }, orderBy: { createdAt: "asc" }, take: 500 });
  const labels = await userLabels(notes.map((n) => n.authorId));
  return notes.map((n) => ({ id: n.id, body: n.body, authorId: n.authorId, authorLabel: labels.get(n.authorId) ?? n.authorId, createdAt: n.createdAt }));
}

export async function addNote(workspaceId: string, postId: string, authorId: string, body: string): Promise<NoteView> {
  await loadRow(workspaceId, postId);
  const text = body.trim();
  if (!text) throw new ContentError(400, "Izoh bo'sh");
  if (text.length > 2000) throw new ContentError(400, "Izoh 2000 belgidan oshmasin");
  const note = await prisma.postNote.create({ data: { postId, authorId, body: text } });
  const labels = await userLabels([authorId]);
  return { id: note.id, body: note.body, authorId, authorLabel: labels.get(authorId) ?? authorId, createdAt: note.createdAt };
}

// ─── Sweeper (FR-A4) ────────────────────────────────────────────────────────

export interface ReviewSweepResult {
  autoApproved: number;
  expired: number;
}

export async function sweepReviews(now: Date = new Date()): Promise<ReviewSweepResult> {
  const result: ReviewSweepResult = { autoApproved: 0, expired: 0 };

  // OPTIONAL: silence until the slot is consent (a rejection would already have moved the post to REJECTED).
  const optional = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: "PENDING_REVIEW", reviewRule: "OPTIONAL", scheduledAt: { lte: now } },
    take: BATCH,
    select: { id: true, workspaceId: true, scheduledAt: true },
  });
  for (const post of optional) {
    try {
      await approveAndSchedule(post.workspaceId, post.id, post.scheduledAt, now);
      await audit(post.workspaceId, `Post ${post.id} auto-approved (OPTIONAL review, no objection by the slot)`, { postId: post.id });
      await notifyOwner(post.id, "approved");
      result.autoApproved++;
    } catch (error) {
      // Not schedulable (quota, broken media): it waits for the grace window like any other.
      console.error("[Content] OPTIONAL auto-approve failed:", error instanceof Error ? error.message : error);
    }
  }

  const overdue = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: "PENDING_REVIEW", scheduledAt: { lt: new Date(now.getTime() - REVIEW_GRACE_MS) } },
    take: BATCH,
    select: { id: true, workspaceId: true },
  });
  for (const post of overdue) {
    const r = await prisma.scheduledPost.updateMany({ where: { id: post.id, status: "PENDING_REVIEW" }, data: { status: "EXPIRED_REVIEW", version: { increment: 1 } } });
    if (r.count === 0) continue;
    await audit(post.workspaceId, `Post ${post.id} review expired (3 h past the slot)`, { postId: post.id });
    await notifyOwner(post.id, "expired");
    result.expired++;
  }
  return result;
}
