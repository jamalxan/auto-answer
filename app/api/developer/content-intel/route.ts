import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { ContentError } from "@/lib/content/errors";
import { AnalysisError, analysesUsed, monthlyAnalysisLimit, queueAnalyses, queueRecent } from "@/lib/content-intel/analyze";
import { ISSUE_TEXT } from "@/lib/content-intel/checks";
import { ExperimentError, cancelExperiment, createHookExperiment, listExperiments } from "@/lib/content-intel/experiments";
import { collectAccountStats, scoreLabel } from "@/lib/content-intel/metrics";
import { PlanError, generatePlan, generateScenario, itemToDraft, listPlans } from "@/lib/content-intel/plan";
import { buildWeeklyReport, tagCorrelations, weekStartOf } from "@/lib/content-intel/report";
import { prisma } from "@/lib/db/client";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/** Content intelligence (audit phase 5) for one Instagram account. */
export async function GET(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const workspaceId = auth.ctx.workspaceId;
  const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true, tokenStatus: true }, orderBy: { connectedAt: "asc" } });
  const accountId = request.nextUrl.searchParams.get("accountId") ?? accounts[0]?.id ?? null;
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const now = new Date();
  const [used, plans, experiments] = await Promise.all([analysesUsed(workspaceId, now), listPlans(workspaceId, account?.id), listExperiments(workspaceId)]);
  if (!account) return jsonOk({ accounts, account: null, stats: [], correlations: [], reports: [], plans, experiments, quota: { used, limit: monthlyAnalysisLimit() }, issueText: ISSUE_TEXT });

  const stats = await prisma.contentPostStat.findMany({
    where: { workspaceId, instagramAccountId: account.id, publishedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
    orderBy: { publishedAt: "desc" },
    take: 100,
  });
  const analyses = stats.length ? await prisma.contentAnalysis.findMany({ where: { statId: { in: stats.map((s) => s.id) } } }) : [];
  const reports = await prisma.contentReport.findMany({ where: { instagramAccountId: account.id }, orderBy: { weekStart: "desc" }, take: 4 });
  return jsonOk({
    accounts,
    account,
    stats: stats.map((s) => {
      const analysis = analyses.find((a) => a.statId === s.id) ?? null;
      return {
        ...s,
        scoreLabel: scoreLabel(s.score),
        analysis: analysis && { status: analysis.status, tags: analysis.tags, issues: analysis.issues, error: analysis.error, analyzedAt: analysis.analyzedAt },
      };
    }),
    correlations: await tagCorrelations(account.id, now),
    reports,
    currentWeek: await buildWeeklyReport(account.id, weekStartOf(now), now),
    plans,
    experiments: experiments.filter((e) => e.instagramAccountId === account.id),
    quota: { used, limit: monthlyAnalysisLimit() },
    issueText: ISSUE_TEXT,
  });
}

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = ((await request.json().catch(() => null)) ?? {}) as Body;
  const { workspaceId, userId } = auth.ctx;
  const accountId = str(body.accountId);
  try {
    switch (body.action) {
      case "collect": {
        if (!accountId) return jsonError("accountId kerak", 400);
        const owned = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { id: true } });
        if (!owned) return jsonError("Akkaunt topilmadi", 404);
        return jsonOk(await collectAccountStats(accountId));
      }
      case "analyze": {
        const ids = Array.isArray(body.statIds) ? body.statIds.filter((x): x is string => typeof x === "string") : [];
        if (ids.length === 0) return jsonError("statIds kerak", 400);
        return jsonOk({ queued: await queueAnalyses(workspaceId, ids) });
      }
      case "analyze_recent":
        if (!accountId) return jsonError("accountId kerak", 400);
        return jsonOk({ queued: await queueRecent(workspaceId, accountId) });
      case "plan_generate":
        if (!accountId) return jsonError("accountId kerak", 400);
        return jsonOk({ plan: await generatePlan(workspaceId, accountId, userId) });
      case "scenario": {
        const planId = str(body.planId);
        const key = str(body.key);
        if (!planId || !key) return jsonError("planId va key kerak", 400);
        return jsonOk({ scenario: await generateScenario(workspaceId, planId, key) });
      }
      case "plan_draft": {
        const planId = str(body.planId);
        const key = str(body.key);
        if (!planId || !key) return jsonError("planId va key kerak", 400);
        return jsonOk(await itemToDraft(workspaceId, planId, key, userId));
      }
      case "experiment_create": {
        const hooks = Array.isArray(body.hooks) ? body.hooks.filter((x): x is string => typeof x === "string") : [];
        if (!accountId) return jsonError("accountId kerak", 400);
        return jsonOk({ experiment: await createHookExperiment(workspaceId, userId, { accountId, title: str(body.title) ?? "", hooks, caption: str(body.caption) ?? undefined }) });
      }
      case "experiment_cancel": {
        const id = str(body.id);
        if (!id) return jsonError("id kerak", 400);
        return (await cancelExperiment(workspaceId, id)) ? jsonOk({ ok: true }) : jsonError("Topilmadi", 404);
      }
      default:
        return jsonError("Noma'lum action", 400);
    }
  } catch (error) {
    if (error instanceof AnalysisError || error instanceof PlanError || error instanceof ExperimentError) return jsonError(error.message, error.status);
    if (error instanceof ContentError) return jsonError(error.message, error.status);
    throw error;
  }
}
