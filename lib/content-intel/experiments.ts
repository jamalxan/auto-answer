/**
 * Trial Reels A/B (audit "Reja va senariy"): hook variants of one Reel are
 * published as Trial Reels (shown to non-followers first; trial_params in
 * the publish API, already supported by the Content Scheduler as TRIAL_REEL).
 *
 *   create    one TRIAL_REEL draft per hook (strategy MANUAL: the owner shares
 *             the winner to followers), within the daily trial limit
 *             (TRIAL_REELS_DAILY_LIMIT, default 20)
 *   evaluate  when every live variant has been out 48 h, the one with the
 *             most views wins; the owner hears it in Telegram
 *
 * Views are read straight from Meta for each variant: trial reels may not be
 * listed in the account's media feed that the stats collector reads.
 */

import { prisma } from "@/lib/db/client";
import { createPost } from "@/lib/content/service";
import { getMediaInsights } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";

const DAY_MS = 86_400_000;
export const DECIDE_AFTER_MS = 48 * 3_600_000;

export function trialDailyLimit(): number {
  const n = Number(process.env.TRIAL_REELS_DAILY_LIMIT ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

export interface Variant {
  hook: string;
  postId: string;
  igMediaId?: string | null;
  views?: number | null;
  dropped?: boolean;
}

export class ExperimentError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function createHookExperiment(
  workspaceId: string,
  userId: string | null,
  input: { accountId: string; title: string; hooks: string[]; caption?: string },
  now = new Date()
) {
  const hooks = [...new Set(input.hooks.map((h) => h.trim()).filter(Boolean))].slice(0, 3);
  if (hooks.length < 2) throw new ExperimentError(400, "Kamida 2 ta har xil hook kerak");
  const account = await prisma.instagramAccount.findFirst({ where: { id: input.accountId, workspaceId }, select: { id: true } });
  if (!account) throw new ExperimentError(404, "Akkaunt topilmadi");
  const recentTrials = await prisma.scheduledPost.count({
    where: { instagramAccountId: account.id, type: "TRIAL_REEL", deletedAt: null, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (recentTrials + hooks.length > trialDailyLimit()) {
    throw new ExperimentError(429, `Trial Reels kunlik limiti (${trialDailyLimit()} ta) — ertaga urinib ko'ring`);
  }
  const variants: Variant[] = [];
  for (const hook of hooks) {
    const post = await createPost(workspaceId, userId, {
      instagramAccountId: account.id,
      type: "TRIAL_REEL",
      trialStrategy: "MANUAL",
      caption: [hook, input.caption?.trim()].filter(Boolean).join("\n\n"),
      isAiGenerated: true,
      media: [],
      labels: ["hook-test"],
    });
    variants.push({ hook, postId: post.id });
  }
  return prisma.hookExperiment.create({
    data: { workspaceId, instagramAccountId: account.id, title: input.title.trim().slice(0, 120) || hooks[0].slice(0, 120), variants: JSON.parse(JSON.stringify(variants)) },
  });
}

export async function listExperiments(workspaceId: string) {
  return prisma.hookExperiment.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 30 });
}

export async function cancelExperiment(workspaceId: string, id: string): Promise<boolean> {
  const result = await prisma.hookExperiment.updateMany({ where: { id, workspaceId, status: "RUNNING" }, data: { status: "CANCELED" } });
  return result.count > 0;
}

export type ViewsReader = (accountId: string, igMediaId: string) => Promise<number | null>;

async function metaViews(accountId: string, igMediaId: string): Promise<number | null> {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { accessToken: true } });
  if (!account) return null;
  const insights = await getMediaInsights(decryptToken(account.accessToken), igMediaId, ["views"]).catch(() => null);
  return typeof insights?.views === "number" ? insights.views : null;
}

const DEAD = new Set(["CANCELED", "REJECTED", "EXPIRED_REVIEW", "FAILED"]);

/** Worker tick: decide experiments whose variants have all been out 48 h. */
export async function evaluateExperiments(now = new Date(), readViews: ViewsReader = metaViews): Promise<number> {
  const running = await prisma.hookExperiment.findMany({ where: { status: "RUNNING" }, take: 50 });
  let decided = 0;
  for (const experiment of running) {
    const variants = (experiment.variants ?? []) as unknown as Variant[];
    const posts = await prisma.scheduledPost.findMany({
      where: { id: { in: variants.map((v) => v.postId) } },
      select: { id: true, status: true, igMediaId: true, publishedAt: true, deletedAt: true },
    });
    let ready = true;
    for (const variant of variants) {
      const post = posts.find((p) => p.id === variant.postId);
      if (!post || post.deletedAt || DEAD.has(post.status)) {
        variant.dropped = true;
        continue;
      }
      if (!post.igMediaId || !post.publishedAt || now.getTime() - post.publishedAt.getTime() < DECIDE_AFTER_MS) {
        ready = false;
        continue;
      }
      variant.igMediaId = post.igMediaId;
      variant.views = await readViews(experiment.instagramAccountId, post.igMediaId);
      if (variant.views === null) ready = false;
    }
    const alive = variants.filter((v) => !v.dropped);
    if (alive.length < 2) {
      await prisma.hookExperiment.update({ where: { id: experiment.id }, data: { status: "CANCELED", variants: JSON.parse(JSON.stringify(variants)) } });
      continue;
    }
    if (!ready) {
      await prisma.hookExperiment.update({ where: { id: experiment.id }, data: { variants: JSON.parse(JSON.stringify(variants)) } });
      continue;
    }
    let winnerIndex = -1;
    variants.forEach((v, i) => {
      if (v.dropped) return;
      if (winnerIndex < 0 || (v.views ?? 0) > (variants[winnerIndex].views ?? 0)) winnerIndex = i;
    });
    const claim = await prisma.hookExperiment.updateMany({
      where: { id: experiment.id, status: "RUNNING" },
      data: { status: "DONE", winnerIndex, decidedAt: now, variants: JSON.parse(JSON.stringify(variants)) },
    });
    if (claim.count === 0) continue;
    decided++;
    const lines = alive.map((v) => `${v === variants[winnerIndex] ? "🏆" : "•"} ${esc(v.hook)} — ${v.views ?? 0} ko'rish`);
    await notifyWorkspaceChats(
      experiment.workspaceId,
      `🧪 <b>Hook testi tugadi:</b> ${esc(experiment.title)}\n${lines.join("\n")}\n\nG'olib variantni Instagram'da obunachilarga ulashing.`
    ).catch(() => 0);
  }
  return decided;
}
