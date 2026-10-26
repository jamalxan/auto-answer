/**
 * Golden eval set (audit 2026-10-26): each account keeps the questions its
 * customers really ask, with what a right answer must / must not contain.
 * Every prompt or model change is re-run against them before it reaches
 * customers; a run is stored with per-case reasons.
 *
 * A case runs through the sandbox turn (same prompt, same KB, nothing sent)
 * and is checked deterministically: expected intent, required and forbidden
 * fragments, and the ladder validators. Usage kind javobai_eval (tooling).
 */

import { findProfile } from "@/lib/assistant/profile";
import { prisma } from "@/lib/db/client";
import { INTENTS } from "./config";
import { loadKnowledgeBlock } from "./knowledge";
import { LadderError } from "./ladder-service";
import { runJavobAiSandbox } from "./sandbox";
import { VALIDATION_ISSUE_TEXT, validateReply } from "./validate";

export const MAX_EVAL_CASES = 60;

export interface EvalCaseInput {
  question: string;
  expectedIntent?: string | null;
  mustContain?: string[];
  mustNotContain?: string[];
  referenceAnswer?: string | null;
}

function cleanList(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

export async function listEvalCases(workspaceId: string, instagramAccountId: string) {
  return prisma.aiEvalCase.findMany({ where: { workspaceId, instagramAccountId }, orderBy: { createdAt: "asc" } });
}

export async function createEvalCase(workspaceId: string, instagramAccountId: string, input: EvalCaseInput, source = "manual") {
  const question = input.question.trim().slice(0, 1000);
  if (!question) throw new LadderError(400, "Savol kerak");
  if (input.expectedIntent && !(INTENTS as readonly string[]).includes(input.expectedIntent)) throw new LadderError(400, "Noma'lum intent");
  const account = await prisma.instagramAccount.findFirst({ where: { id: instagramAccountId, workspaceId }, select: { id: true } });
  if (!account) throw new LadderError(404, "Akkaunt topilmadi");
  if ((await prisma.aiEvalCase.count({ where: { instagramAccountId, active: true } })) >= MAX_EVAL_CASES) {
    throw new LadderError(409, `Ko'pi bilan ${MAX_EVAL_CASES} ta faol savol`);
  }
  return prisma.aiEvalCase.create({
    data: {
      workspaceId,
      instagramAccountId,
      question,
      expectedIntent: input.expectedIntent || null,
      mustContain: cleanList(input.mustContain),
      mustNotContain: cleanList(input.mustNotContain),
      referenceAnswer: input.referenceAnswer?.trim().slice(0, 2000) || null,
      source,
    },
  });
}

/** A judged-as-matching operator reply becomes a golden case (question + reference). */
export async function evalCaseFromSample(workspaceId: string, shadowTurnId: string) {
  const sample = await prisma.aiShadowTurn.findFirst({ where: { id: shadowTurnId, workspaceId } });
  if (!sample || !sample.instagramAccountId) throw new LadderError(404, "Namuna topilmadi");
  return createEvalCase(
    workspaceId,
    sample.instagramAccountId,
    { question: sample.customerText, expectedIntent: sample.intent, referenceAnswer: sample.operatorReply || null },
    "observed"
  );
}

export async function updateEvalCase(workspaceId: string, id: string, patch: Partial<EvalCaseInput> & { active?: boolean }) {
  const row = await prisma.aiEvalCase.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!row) throw new LadderError(404, "Savol topilmadi");
  return prisma.aiEvalCase.update({
    where: { id },
    data: {
      ...(patch.question !== undefined ? { question: patch.question.trim().slice(0, 1000) } : {}),
      ...(patch.expectedIntent !== undefined ? { expectedIntent: patch.expectedIntent || null } : {}),
      ...(patch.mustContain !== undefined ? { mustContain: cleanList(patch.mustContain) } : {}),
      ...(patch.mustNotContain !== undefined ? { mustNotContain: cleanList(patch.mustNotContain) } : {}),
      ...(patch.referenceAnswer !== undefined ? { referenceAnswer: patch.referenceAnswer?.trim() || null } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });
}

export async function deleteEvalCase(workspaceId: string, id: string): Promise<boolean> {
  const result = await prisma.aiEvalCase.deleteMany({ where: { id, workspaceId } });
  return result.count > 0;
}

export interface EvalCaseResult {
  caseId: string;
  question: string;
  reply: string;
  intent: string;
  pass: boolean;
  reasons: string[];
}

/** Pure: one case's verdict. */
export function checkEvalCase(
  c: { expectedIntent: string | null; mustContain: string[]; mustNotContain: string[] },
  out: { reply: string; intent: string; knowledge: string }
): string[] {
  const reasons: string[] = [];
  const reply = out.reply.toLowerCase();
  if (!out.reply.trim()) reasons.push("Javob bo'sh");
  if (c.expectedIntent && c.expectedIntent !== out.intent) reasons.push(`Intent ${out.intent} (kutilgan ${c.expectedIntent})`);
  for (const f of c.mustContain) if (!reply.includes(f.toLowerCase())) reasons.push(`Yo'q: «${f}»`);
  for (const f of c.mustNotContain) if (reply.includes(f.toLowerCase())) reasons.push(`Bo'lmasligi kerak: «${f}»`);
  for (const issue of validateReply({ reply: out.reply, knowledge: out.knowledge })) reasons.push(VALIDATION_ISSUE_TEXT[issue]);
  return reasons;
}

/** Starts a run and returns its id; the cases are answered in the background (a run takes minutes). */
export async function startEvalRun(workspaceId: string, instagramAccountId: string, by: string): Promise<string> {
  const cases = await prisma.aiEvalCase.findMany({ where: { workspaceId, instagramAccountId, active: true }, orderBy: { createdAt: "asc" }, take: MAX_EVAL_CASES });
  if (cases.length === 0) throw new LadderError(400, "Avval golden savollar qo'shing");
  const running = await prisma.aiEvalRun.findFirst({ where: { instagramAccountId, status: "RUNNING", startedAt: { gt: new Date(Date.now() - 15 * 60_000) } } });
  if (running) throw new LadderError(409, "Eval allaqachon ishlayapti");
  const { javobAiModel } = await import("./config");
  const run = await prisma.aiEvalRun.create({ data: { workspaceId, instagramAccountId, model: javobAiModel() ?? "default", total: cases.length, triggeredBy: by } });
  void executeEvalRun(run.id, workspaceId, instagramAccountId, cases).catch(async (error) => {
    await prisma.aiEvalRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), results: [{ error: error instanceof Error ? error.message.slice(0, 300) : "xato" }] } })
      .catch(() => {});
  });
  return run.id;
}

export async function executeEvalRun(
  runId: string,
  workspaceId: string,
  instagramAccountId: string,
  cases: Array<{ id: string; question: string; expectedIntent: string | null; mustContain: string[]; mustNotContain: string[] }>
): Promise<{ passed: number; failed: number }> {
  const profile = await findProfile(workspaceId, instagramAccountId);
  const results: EvalCaseResult[] = [];
  let passed = 0;
  for (const c of cases) {
    let reply = "";
    let intent = "other";
    let reasons: string[];
    try {
      const out = await runJavobAiSandbox(workspaceId, { instagramAccountId, messages: [{ role: "customer", text: c.question }], usageKind: "javobai_eval" });
      reply = out.reply;
      intent = out.intent;
      const kb = profile ? await loadKnowledgeBlock(profile.id, c.question) : null;
      reasons = out.blockedBy === "budget" ? ["AI byudjeti tugagan"] : checkEvalCase(c, { reply, intent, knowledge: `${kb?.text ?? ""}\n${kb?.filterContext.profileText ?? ""}\n${c.question}` });
    } catch (error) {
      reasons = [error instanceof Error ? error.message.slice(0, 200) : "Xato"];
    }
    const pass = reasons.length === 0;
    if (pass) passed++;
    results.push({ caseId: c.id, question: c.question, reply, intent, pass, reasons });
    await prisma.aiEvalRun.update({ where: { id: runId }, data: { passed, failed: results.length - passed, results: JSON.parse(JSON.stringify(results)) } });
  }
  await prisma.aiEvalRun.update({ where: { id: runId }, data: { status: "DONE", finishedAt: new Date() } });
  return { passed, failed: results.length - passed };
}

export async function listEvalRuns(workspaceId: string, instagramAccountId: string, take = 10) {
  return prisma.aiEvalRun.findMany({ where: { workspaceId, instagramAccountId }, orderBy: { startedAt: "desc" }, take });
}
