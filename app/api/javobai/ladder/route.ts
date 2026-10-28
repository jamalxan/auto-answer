import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { requireWorkspace } from "@/lib/channels/guard";
import { listCommentModerations } from "@/lib/javobai/comment-guard";
import { approveFactCandidate, listFactCandidates, rejectFactCandidate } from "@/lib/javobai/facts";
import { createEvalCase, deleteEvalCase, evalCaseFromSample, listEvalCases, listEvalRuns, startEvalRun, updateEvalCase } from "@/lib/javobai/eval";
import { LadderError, discardDraft, ladderOverview, listDrafts, recentCriticalSamples, setIntentMode } from "@/lib/javobai/ladder-service";
import { sendJavobAiDraft } from "@/lib/javobai/runtime";

export const dynamic = "force-dynamic";

/** ?accountId= — the whole ladder page in one read: intents, drafts, facts, eval, guard log. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const ws = auth.ctx.workspaceId;
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return jsonError("accountId kerak", 400);
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId: ws }, select: { id: true } });
  if (!account) return jsonError("Akkaunt topilmadi", 404);
  const [intents, drafts, facts, cases, runs, critical, moderations] = await Promise.all([
    ladderOverview(ws, accountId),
    listDrafts(ws),
    listFactCandidates(ws),
    listEvalCases(ws, accountId),
    listEvalRuns(ws, accountId),
    recentCriticalSamples(ws, accountId),
    listCommentModerations(ws, 50),
  ]);
  return jsonOk({
    intents,
    drafts: drafts.filter((d) => d.instagramAccountId === accountId),
    facts,
    cases,
    runs,
    critical,
    moderations: moderations.filter((m) => m.instagramAccountId === accountId),
  });
}

type Body = Record<string, unknown> & { action?: unknown };

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : undefined);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/**
 * { action, ... }:
 *   set_mode { accountId, intent, mode } · draft_send { id, text? } · draft_drop { id }
 *   fact_approve { id, title?, body?, kind?, validUntil? } · fact_reject { id }
 *   case_create { accountId, question, expectedIntent?, mustContain?, mustNotContain?, referenceAnswer? }
 *   case_from_sample { shadowTurnId } · case_update { id, ... , active? } · case_delete { id }
 *   eval_run { accountId }
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const ws = auth.ctx.workspaceId;
  const by = `user:${auth.ctx.userId}`;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body.action !== "string") return jsonError("action kerak", 400);
  const id = str(body.id, 64) ?? "";
  try {
    switch (body.action) {
      case "set_mode": {
        const mode = body.mode;
        if (mode !== "OBSERVE" && mode !== "COPILOT" && mode !== "AUTO") return jsonError("mode: OBSERVE | COPILOT | AUTO", 400);
        return jsonOk(await setIntentMode(ws, str(body.accountId, 64) ?? "", str(body.intent, 64) ?? "", mode, by));
      }
      case "draft_send": {
        const result = await sendJavobAiDraft(ws, id, by, str(body.text) ?? null);
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? "Yuborilmadi", 409);
      }
      case "draft_drop":
        return (await discardDraft(ws, id, by)) ? jsonOk({ ok: true }) : jsonError("Qoralama topilmadi yoki ko'rib chiqilgan", 409);
      case "fact_approve":
        return jsonOk(
          await approveFactCandidate(ws, id, by, {
            title: str(body.title, 120),
            body: str(body.body),
            kind: str(body.kind, 20),
            validUntil: body.validUntil === null ? null : str(body.validUntil, 40),
          })
        );
      case "fact_reject":
        return (await rejectFactCandidate(ws, id, by)) ? jsonOk({ ok: true }) : jsonError("Fakt topilmadi yoki ko'rib chiqilgan", 409);
      case "case_create":
        return jsonOk(
          await createEvalCase(ws, str(body.accountId, 64) ?? "", {
            question: str(body.question, 1000) ?? "",
            expectedIntent: str(body.expectedIntent, 64) ?? null,
            mustContain: strList(body.mustContain),
            mustNotContain: strList(body.mustNotContain),
            referenceAnswer: str(body.referenceAnswer) ?? null,
          })
        );
      case "case_from_sample":
        return jsonOk(await evalCaseFromSample(ws, str(body.shadowTurnId, 64) ?? ""));
      case "case_update":
        return jsonOk(
          await updateEvalCase(ws, id, {
            question: str(body.question, 1000),
            expectedIntent: body.expectedIntent === null ? null : str(body.expectedIntent, 64),
            mustContain: strList(body.mustContain),
            mustNotContain: strList(body.mustNotContain),
            referenceAnswer: body.referenceAnswer === null ? null : str(body.referenceAnswer),
            active: typeof body.active === "boolean" ? body.active : undefined,
          })
        );
      case "case_delete":
        return (await deleteEvalCase(ws, id)) ? jsonOk({ ok: true }) : jsonError("Savol topilmadi", 404);
      case "eval_run":
        return jsonOk({ runId: await startEvalRun(ws, str(body.accountId, 64) ?? "", by) });
      default:
        return jsonError("Noma'lum action", 400);
    }
  } catch (error) {
    if (error instanceof LadderError) return jsonError(error.message, error.status);
    throw error;
  }
}
