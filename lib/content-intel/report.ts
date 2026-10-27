/**
 * Content intelligence, step 3a: what the tags say about results, and the
 * weekly report (audit "Natija — haftalik hisobot").
 *
 * Correlations compare medians, not averages: one viral Reel must not make
 * "savol hook" look like a rule. A tag value needs three analysed posts
 * before it is reported.
 *
 * The report is computed from stored stats (no LLM, no Meta call), saved
 * once per account and week, and sent to the workspace's Telegram chats on
 * Monday morning (workspace zone) for the week that just ended.
 */

import { prisma } from "@/lib/db/client";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { DEFAULT_TIMEZONE, utcToZoned, zonedToUtc } from "@/lib/content/time";
import { ISSUE_TEXT, type IssueCode } from "./checks";
import { median, scoreLabel } from "./metrics";

const DAY_MS = 86_400_000;
export const CORRELATION_MIN_POSTS = 3;
const REPORT_HOUR = 9;

const TAG_LABEL: Record<string, string> = {
  hookType: "Hook",
  format: "Format",
  hasSubtitles: "Subtitr",
  hasCta: "CTA",
};

const VALUE_LABEL: Record<string, string> = {
  true: "bor",
  false: "yo'q",
  talking_head: "kameraga gapirish",
  b_roll: "b-roll",
  ekran_yozuvi: "ekran yozuvi",
};

export interface Correlation {
  tag: string;
  value: string;
  label: string;
  medianScore: number;
  posts: number;
}

export async function tagCorrelations(accountId: string, now = new Date(), days = 90): Promise<Correlation[]> {
  const stats = await prisma.contentPostStat.findMany({
    where: { instagramAccountId: accountId, publishedAt: { gte: new Date(now.getTime() - days * DAY_MS) }, score: { not: null } },
    select: { id: true, score: true },
  });
  if (stats.length === 0) return [];
  const analyses = await prisma.contentAnalysis.findMany({ where: { statId: { in: stats.map((s) => s.id) }, status: "DONE" }, select: { statId: true, tags: true } });
  const groups = new Map<string, number[]>();
  for (const analysis of analyses) {
    const score = stats.find((s) => s.id === analysis.statId)?.score;
    if (typeof score !== "number") continue;
    const tags = (analysis.tags ?? {}) as Record<string, unknown>;
    for (const tag of Object.keys(TAG_LABEL)) {
      const value = tags[tag];
      if (value === null || value === undefined || value === "") continue;
      const key = `${tag}=${String(value)}`;
      groups.set(key, [...(groups.get(key) ?? []), score]);
    }
  }
  const out: Correlation[] = [];
  for (const [key, scores] of groups) {
    if (scores.length < CORRELATION_MIN_POSTS) continue;
    const [tag, value] = key.split("=");
    const m = median(scores) ?? 0;
    out.push({ tag, value, label: `${TAG_LABEL[tag]}: ${VALUE_LABEL[value] ?? value}`, medianScore: Math.round(m * 100) / 100, posts: scores.length });
  }
  return out.sort((a, b) => Math.abs(b.medianScore - 1) - Math.abs(a.medianScore - 1));
}

export interface ReportPost {
  statId: string;
  permalink: string | null;
  caption: string;
  publishedAt: string;
  views: number | null;
  score: number | null;
  scoreLabel: string;
  leads: number;
  sales: number;
  issues: string[];
  note: string | null;
}

export interface WeeklyReportBody {
  weekStart: string;
  weekEnd: string;
  posts: ReportPost[];
  totals: { posts: number; views: number; comments: number; dms: number; leads: number; sales: number };
  top: ReportPost[];
  bottom: ReportPost[];
  issues: Array<{ code: string; text: string; posts: number }>;
  correlations: Correlation[];
}

/** Monday 00:00 (in `tz`) of the week containing `at`, as a UTC instant. */
export function weekStartOf(at: Date, tz = DEFAULT_TIMEZONE): Date {
  const { date } = utcToZoned(at, tz);
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(day.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
  return zonedToUtc(monday, "00:00", tz);
}

export async function buildWeeklyReport(accountId: string, weekStart: Date, now = new Date()): Promise<WeeklyReportBody> {
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  const stats = await prisma.contentPostStat.findMany({
    where: { instagramAccountId: accountId, publishedAt: { gte: weekStart, lt: weekEnd } },
    orderBy: { publishedAt: "asc" },
  });
  const analyses = stats.length
    ? await prisma.contentAnalysis.findMany({ where: { statId: { in: stats.map((s) => s.id) }, status: "DONE" }, select: { statId: true, issues: true, tags: true } })
    : [];
  const posts: ReportPost[] = stats.map((s) => {
    const analysis = analyses.find((a) => a.statId === s.id);
    const note = (analysis?.tags as { note?: string } | undefined)?.note ?? null;
    return {
      statId: s.id,
      permalink: s.permalink,
      caption: (s.caption ?? "").slice(0, 120),
      publishedAt: s.publishedAt.toISOString(),
      views: s.views,
      score: s.score,
      scoreLabel: scoreLabel(s.score),
      leads: s.bizLeads,
      sales: s.bizSales,
      issues: analysis?.issues ?? [],
      note,
    };
  });
  const ranked = posts.filter((p) => p.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const issueCount = new Map<string, number>();
  for (const p of posts) for (const code of p.issues) issueCount.set(code, (issueCount.get(code) ?? 0) + 1);
  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    posts,
    totals: {
      posts: stats.length,
      views: stats.reduce((sum, s) => sum + (s.views ?? 0), 0),
      comments: stats.reduce((sum, s) => sum + s.bizComments, 0),
      dms: stats.reduce((sum, s) => sum + s.bizDms, 0),
      leads: stats.reduce((sum, s) => sum + s.bizLeads, 0),
      sales: stats.reduce((sum, s) => sum + s.bizSales, 0),
    },
    top: ranked.slice(0, 3),
    bottom: ranked.length > 3 ? ranked.slice(-2).reverse() : [],
    issues: [...issueCount.entries()]
      .map(([code, n]) => ({ code, text: ISSUE_TEXT[code as IssueCode] ?? code, posts: n }))
      .sort((a, b) => b.posts - a.posts),
    correlations: (await tagCorrelations(accountId, now)).slice(0, 5),
  };
}

export function reportText(username: string, body: WeeklyReportBody): string {
  const lines = [`📊 <b>@${esc(username)} — haftalik kontent hisoboti</b>`];
  const t = body.totals;
  if (t.posts === 0) {
    lines.push("Bu hafta post chiqmadi.");
    return lines.join("\n");
  }
  lines.push(`${t.posts} post · ${t.views} ko'rish · ${t.comments} komment → ${t.dms} DM → ${t.leads} lid → ${t.sales} sotuv`);
  if (body.top.length) {
    lines.push("\n<b>Eng yaxshilari</b>");
    for (const p of body.top) lines.push(`• ${esc(p.caption || "(matnsiz)")} — ${esc(p.scoreLabel)}${p.leads ? `, ${p.leads} lid` : ""}${p.note ? `\n  ${esc(p.note)}` : ""}`);
  }
  if (body.bottom.length) {
    lines.push("\n<b>Kuchsizlari</b>");
    for (const p of body.bottom) lines.push(`• ${esc(p.caption || "(matnsiz)")} — ${esc(p.scoreLabel)}`);
  }
  if (body.issues.length) {
    lines.push("\n<b>Tipik xatolar</b>");
    for (const issue of body.issues.slice(0, 5)) lines.push(`• ${esc(issue.text)} (${issue.posts} post)`);
  }
  if (body.correlations.length) {
    lines.push("\n<b>Nima ishlayapti</b>");
    for (const c of body.correlations.slice(0, 3)) lines.push(`• ${esc(c.label)} — medianadan ${c.medianScore}× (${c.posts} post)`);
  }
  return lines.join("\n");
}

/** Save (and send, once) last week's report for every account that has stats. */
export async function runWeeklyReports(now = new Date()): Promise<number> {
  const recent = await prisma.contentPostStat.findMany({
    where: { publishedAt: { gte: new Date(now.getTime() - 14 * DAY_MS) } },
    select: { instagramAccountId: true, workspaceId: true },
  });
  const accounts = [...new Map(recent.map((r) => [r.instagramAccountId, r])).values()];
  let sent = 0;
  for (const row of accounts) {
    const ws = await prisma.workspace.findUnique({ where: { id: row.workspaceId }, select: { timezone: true } });
    const tz = ws?.timezone || DEFAULT_TIMEZONE;
    const thisWeek = weekStartOf(now, tz);
    if (now.getTime() < thisWeek.getTime() + REPORT_HOUR * 3_600_000) continue; // Monday before 09:00
    const lastWeek = new Date(thisWeek.getTime() - 7 * DAY_MS);
    const existing = await prisma.contentReport.findUnique({ where: { instagramAccountId_weekStart: { instagramAccountId: row.instagramAccountId, weekStart: lastWeek } } });
    if (existing?.sentAt) continue;
    const body = await buildWeeklyReport(row.instagramAccountId, lastWeek, now);
    const report = await prisma.contentReport.upsert({
      where: { instagramAccountId_weekStart: { instagramAccountId: row.instagramAccountId, weekStart: lastWeek } },
      create: { workspaceId: row.workspaceId, instagramAccountId: row.instagramAccountId, weekStart: lastWeek, body: JSON.parse(JSON.stringify(body)) },
      update: { body: JSON.parse(JSON.stringify(body)) },
    });
    // Claim before sending: two workers never send the same report twice.
    const claim = await prisma.contentReport.updateMany({ where: { id: report.id, sentAt: null }, data: { sentAt: now } });
    if (claim.count === 0) continue;
    if (body.totals.posts === 0) continue;
    const account = await prisma.instagramAccount.findUnique({ where: { id: row.instagramAccountId }, select: { username: true } });
    await notifyWorkspaceChats(row.workspaceId, reportText(account?.username ?? "akkaunt", body)).catch(() => 0);
    sent++;
  }
  return sent;
}
