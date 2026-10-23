/**
 * ETAP 13 — "Qo'lda e'lon" over Telegram (spec §5.5): when the API cannot
 * publish a post (story stickers, music, a rejected file, auto-publish
 * switched off) the workspace's Telegram chats get the files, the caption
 * as a copyable message, the tag list and two buttons. "E'lon qildim"
 * marks the post PUBLISHED_MANUAL; the sweeper then binds the real media
 * id so a linked campaign still activates.
 */

import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { esc, sendMediaGroup, sendMessage, sendPhoto, sendVideo, type InlineKeyboard } from "@/lib/telegram/api";
import { alertWorkspace, getWorkspaceChats } from "@/lib/telegram/notify";
import { SIGNED_URL_TTL_SEC } from "./config";
import { activateLinkedCampaigns } from "./link-campaign";
import { itemMediaKey } from "./crop";
import { withKeyLock } from "./lock";
import { signedMediaUrl } from "./media";
import { removePostJobs } from "./queue";
import type { PostStatusValue } from "./schema";
import { formatZoned } from "./time";

export interface ManualDeps {
  now?: () => Date;
}

export type ManualNoticeResult = { delivered: "telegram" | "email" | "none" };

const MANUAL_NOTICE_STEP = "MANUAL_NOTICE";
const BIND_WINDOW_MS = 30 * 60_000;
const INSTAGRAM_URL = "https://www.instagram.com/";

const POST_INCLUDE = {
  instagramAccount: true,
  media: { include: { media: true }, orderBy: { position: "asc" as const } },
};

async function loadPost(postId: string) {
  return prisma.scheduledPost.findUnique({ where: { id: postId }, include: POST_INCLUDE });
}
type PostRow = NonNullable<Awaited<ReturnType<typeof loadPost>>>;

const TYPE_LABEL: Record<string, string> = { FEED_IMAGE: "Post", FEED_VIDEO: "Video", CAROUSEL: "Karusel", REEL: "Reels", TRIAL_REEL: "Trial Reels", STORY: "Story" };

const REASON_LABEL: Record<string, string> = {
  STORY_STICKER: "story'da stiker / havola bor",
  MUSIC: "musiqa qo'shish kerak",
  API_REJECTED: "Instagram API faylni qabul qilmadi",
  USER_CHOICE: "avto-publish o'chirilgan",
};

function tagsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as Array<{ username?: string }>).map((t) => t?.username).filter((u): u is string => typeof u === "string") : [];
}

/** The text message with everything the person needs besides the files; download links when Telegram refused the files. */
function detailsText(post: PostRow, downloadLinks: string[] = []): string {
  const lines = [
    `📣 <b>${TYPE_LABEL[post.type] ?? post.type} — qo'lda e'lon vaqti</b> (@${esc(post.instagramAccount.username)})`,
    post.scheduledAt ? `🕒 ${formatZoned(post.scheduledAt, post.timezone)}` : "",
    post.manualReason ? `Sabab: ${REASON_LABEL[post.manualReason] ?? post.manualReason}` : "",
  ];
  const tags = [...new Set(post.media.flatMap((m) => tagsOf(m.userTags)))];
  if (tags.length) lines.push(`👤 Belgilash: ${tags.map((t) => `@${esc(t)}`).join(", ")}`);
  if (post.collaborators.length) lines.push(`🤝 Hammualliflar: ${post.collaborators.map((c) => `@${esc(c)}`).join(", ")}`);
  if (post.firstComment?.trim()) lines.push(`💬 Birinchi komment:\n${esc(post.firstComment.trim())}`);
  if (post.type === "REEL" || post.type === "TRIAL_REEL" || post.type === "FEED_VIDEO") {
    lines.push(post.shareToFeed ? "📌 Feed'da ham ko'rsating" : "📌 Faqat Reels tabida (feed'ga chiqarmang)");
  }
  if (downloadLinks.length) {
    lines.push("", "📎 Telegram faylni qabul qilmadi (hajm limiti) — yuklab oling (24 soat amal qiladi):", ...downloadLinks.map((l, i) => `${i + 1}. ${esc(l)}`));
  }
  lines.push("", "Chiqargach «✅ E'lon qildim» ni bosing — kampaniya postga ulanadi.");
  return lines.filter((l) => l !== "").join("\n");
}

function keyboard(postId: string): InlineKeyboard {
  return [
    [{ text: "✅ E'lon qildim", callback_data: `content:done:${postId}` }],
    [{ text: "❌ Bekor qilish", callback_data: `content:cancel:${postId}` }],
    [{ text: "Instagram'ni ochish", url: INSTAGRAM_URL }],
  ];
}

async function alreadyNotified(postId: string): Promise<boolean> {
  const n = await prisma.publishAttempt.count({ where: { postId, step: MANUAL_NOTICE_STEP, ok: true } });
  return n > 0;
}

/**
 * Move the post into manual mode (if it is not there yet) and deliver the
 * notice once: Telegram when a chat is connected, otherwise one email.
 */
export async function sendManualNotice(postId: string, deps: ManualDeps = {}): Promise<ManualNoticeResult> {
  const now = deps.now ?? (() => new Date());
  const post = await loadPost(postId);
  if (!post || post.deletedAt) return { delivered: "none" };
  if (post.status !== "NEEDS_MANUAL") {
    const from: PostStatusValue[] = ["SCHEDULED", "FAILED", "PREPARING", "READY_TO_PUBLISH", "PAUSED"];
    if (!from.includes(post.status)) return { delivered: "none" };
    const r = await prisma.scheduledPost.updateMany({
      where: { id: postId, status: { in: from } },
      data: {
        status: "NEEDS_MANUAL",
        manualReason: post.manualReason ?? (post.status === "FAILED" ? "API_REJECTED" : "USER_CHOICE"),
        version: { increment: 1 },
      },
    });
    if (r.count === 0) return { delivered: "none" };
    await removePostJobs(postId, post.attempts).catch(() => undefined);
  }
  // Two sweeper runs (or a sweep and the notify job) can reach this point together: one sender per post (M1).
  const locked = await withKeyLock(`content:notice:${postId}`, () => deliverNotice(postId));
  return locked.acquired ? locked.result : { delivered: "none" };
}

async function deliverNotice(postId: string): Promise<ManualNoticeResult> {
  if (await alreadyNotified(postId)) return { delivered: "none" };

  const row = (await loadPost(postId))!;
  const chats = await getWorkspaceChats(row.workspaceId);
  const files = await Promise.all(
    row.media.map(async (m) => ({
      type: m.media.kind === "VIDEO" ? ("video" as const) : ("photo" as const),
      media: await signedMediaUrl(await itemMediaKey(m), SIGNED_URL_TTL_SEC),
    }))
  );

  if (chats.length > 0) {
    let delivered = 0;
    for (const chat of chats) {
      // Telegram caps URL uploads (20 MB video / 5 MB photo); a refused file must not swallow the caption and the buttons.
      let mediaSent = true;
      try {
        if (files.length > 1) await sendMediaGroup(chat.chatId, files);
        else if (files.length === 1 && files[0].type === "video") await sendVideo(chat.chatId, files[0].media);
        else if (files.length === 1) await sendPhoto(chat.chatId, files[0].media);
      } catch (error) {
        mediaSent = false;
        console.error("[Content] manual notice media refused by Telegram:", error instanceof Error ? error.message : error);
      }
      try {
        if (row.caption?.trim()) await sendMessage(chat.chatId, row.caption.trim(), { parseMode: null });
        await sendMessage(chat.chatId, detailsText(row, mediaSent ? [] : files.map((f) => f.media)), { keyboard: keyboard(postId) });
        delivered++;
      } catch (error) {
        console.error("[Content] manual notice to chat failed:", error instanceof Error ? error.message : error);
      }
    }
    if (delivered > 0) {
      await prisma.publishAttempt.create({ data: { postId, step: MANUAL_NOTICE_STEP, ok: true, message: `telegram ×${delivered}` } });
      return { delivered: "telegram" };
    }
  }

  // FR-N4: no Telegram — the owner gets an email and the dashboard shows the post.
  const label = TYPE_LABEL[row.type] ?? row.type;
  const when = row.scheduledAt ? formatZoned(row.scheduledAt, row.timezone) : "";
  await alertWorkspace(
    row.workspaceId,
    `${label} ni qo'lda chiqarish vaqti — @${row.instagramAccount.username}`,
    `📣 <b>${label} ni qo'lda chiqarish vaqti</b> (@${esc(row.instagramAccount.username)}${when ? `, ${when}` : ""})\nSocialAuto → Kontent bo'limida faylni yuklab oling va caption'dan nusxa oling.`,
    `${label} ni qo'lda chiqarish vaqti (@${row.instagramAccount.username}${when ? `, ${when}` : ""}). SocialAuto → Kontent bo'limida faylni yuklab oling va caption'dan nusxa oling. Telegram'ni ulasangiz fayllar o'sha yerga keladi.`
  ).catch(() => undefined);
  await prisma.operationalEvent
    .create({ data: { workspaceId: row.workspaceId, source: "WORKER", level: "WARNING", message: `Manual publish needed for post ${postId} (no Telegram chat)`, payload: { postId } } })
    .catch(() => undefined);
  await prisma.publishAttempt.create({ data: { postId, step: MANUAL_NOTICE_STEP, ok: true, message: "email" } });
  await prisma.scheduledPost.update({ where: { id: postId }, data: { lastErrorMessage: "Telegram ulanmagan — e-mail yuborildi", version: { increment: 1 } } }).catch(() => undefined);
  return { delivered: "email" };
}

// ─── Telegram buttons ───────────────────────────────────────────────────────

export interface CallbackContext {
  tgUserId: string;
  chatId?: string;
}

/** May this Telegram user / chat act on the workspace's posts? */
async function mayAct(workspaceId: string, ctx: CallbackContext): Promise<boolean> {
  const link = await prisma.telegramUser.findUnique({ where: { tgUserId: ctx.tgUserId } });
  if (link?.workspaceId === workspaceId) return true;
  if (!ctx.chatId) return false;
  const chat = await prisma.telegramChat.findFirst({
    where: { chatId: ctx.chatId, active: true, integration: { workspaceId, type: "TELEGRAM" } },
    select: { id: true },
  });
  return Boolean(chat);
}

/** "content:done:<id>" / "content:cancel:<id>" → the toast text for answerCallbackQuery. */
export async function handleContentCallback(data: string, ctx: CallbackContext): Promise<string> {
  const [, action, postId] = data.split(":");
  if (!postId || (action !== "done" && action !== "cancel")) return "Noma'lum amal";
  const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, select: { id: true, workspaceId: true, status: true, deletedAt: true, attempts: true } });
  if (!post || post.deletedAt) return "Post topilmadi";
  if (!(await mayAct(post.workspaceId, ctx))) return "Bu amalga ruxsat yo'q";
  if (action === "done") {
    if (post.status === "PUBLISHED_MANUAL") return "Allaqachon belgilangan";
    const r = await prisma.scheduledPost.updateMany({
      where: { id: postId, status: { in: ["NEEDS_MANUAL", "SCHEDULED", "FAILED"] } },
      data: { status: "PUBLISHED_MANUAL", publishedAt: new Date(), version: { increment: 1 } },
    });
    if (r.count === 0) return "Post bu holatda emas";
    await removePostJobs(postId, post.attempts).catch(() => undefined);
    return "✅ Chiqarilgan deb belgilandi — kampaniya 30 daqiqa ichida ulanadi";
  }
  const r = await prisma.scheduledPost.updateMany({
    where: { id: postId, status: { in: ["NEEDS_MANUAL", "SCHEDULED", "FAILED", "PAUSED"] } },
    data: { status: "CANCELED", version: { increment: 1 } },
  });
  if (r.count === 0) return "Post bu holatda emas";
  await removePostJobs(postId, post.attempts).catch(() => undefined);
  const { pauseLinkedCampaigns } = await import("./link-campaign");
  await pauseLinkedCampaigns(postId).catch(() => undefined);
  return "Post bekor qilindi";
}

// ─── Binding the real media id (FR-N3) ──────────────────────────────────────

function kindMatches(post: PostRow, media: InstagramMedia): boolean {
  if (post.type === "CAROUSEL") return media.media_type === "CAROUSEL_ALBUM";
  if (post.type === "STORY") return true;
  const wantsVideo = post.media.some((m) => m.media.kind === "VIDEO");
  return wantsVideo ? media.media_type === "VIDEO" : media.media_type === "IMAGE";
}

/** After "E'lon qildim": the newest account media since the confirmation becomes the post's id. */
export async function bindManualPost(postId: string): Promise<boolean> {
  const post = await loadPost(postId);
  if (!post || post.status !== "PUBLISHED_MANUAL" || post.igMediaId || !post.publishedAt) return false;
  if (Date.now() - post.publishedAt.getTime() > BIND_WINDOW_MS + 5 * 60_000) return false;
  const token = decryptToken(post.instagramAccount.accessToken);
  const list = await getUserMedia(token, 10).catch(() => [] as InstagramMedia[]);
  const since = post.publishedAt.getTime() - 5 * 60_000;
  const found = list
    .filter((m) => kindMatches(post, m))
    .filter((m) => (m.timestamp ? new Date(m.timestamp).getTime() >= since : false))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  if (!found) return false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.scheduledPost.update({ where: { id: postId }, data: { igMediaId: found.id, permalink: found.permalink ?? null, version: { increment: 1 } } });
      await activateLinkedCampaigns(tx, postId, found.id);
    });
    await prisma.publishAttempt.create({ data: { postId, step: "LINK_CAMPAIGN", ok: true, message: `manual bind → ${found.id}` } });
    return true;
  } catch (error) {
    await prisma.publishAttempt.create({ data: { postId, step: "LINK_CAMPAIGN", ok: false, message: error instanceof Error ? error.message : String(error) } });
    return false;
  }
}
