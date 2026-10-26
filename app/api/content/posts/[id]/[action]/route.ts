import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { movePost } from "@/lib/content/bulk";
import { ContentError } from "@/lib/content/errors";
import { canContent } from "@/lib/content/permissions";
import { recurInputSchema } from "@/lib/content/recurrence";
import { applyToSeries, deleteSeriesFuture, recurPost } from "@/lib/content/series";
import { queuePost } from "@/lib/content/slots";
import { addNote, decide, getReviewSummary, listNotes, noteInputSchema, reviewDecisionSchema, reviewSubmitSchema, submitForReview } from "@/lib/content/review";
import { duplicateInputSchema, scheduleInputSchema } from "@/lib/content/schema";
import {
  cancelPost,
  duplicatePost,
  markPublishedManually,
  pausePost,
  publishNow,
  resumePost,
  retryPost,
  run,
  schedulePost,
  unschedulePost,
} from "@/lib/content/service";
import { isValidTimeZone, zonedToUtc } from "@/lib/content/time";
import { parseBody, readJson, requireContent, respond, type ContentAccess } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; action: string }> };

/** Which permission each state change needs (spec §9). */
const ACTIONS: Record<string, ContentAccess> = {
  schedule: "schedule",
  "publish-now": "schedule",
  pause: "schedule",
  resume: "schedule",
  unschedule: "schedule",
  retry: "schedule",
  cancel: "schedule",
  "mark-published": "create",
  duplicate: "create",
  // Faza 2 — series and slots (FR-S8, FR-S9)
  recur: "schedule",
  queue: "schedule",
  "delete-series-future": "schedule",
  "apply-to-series": "create",
  // Approval (Faza 2, FR-A1): OPERATOR+ submits, MANAGER+ decides, notes by anyone who may draft.
  review: "create",
  decision: "approve",
  notes: "create",
  // FR-S6 drag-and-drop / "Ko'chirish": a draft's plan is an edit, a SCHEDULED post needs schedule (checked in movePost).
  move: "create",
};

/** Read-only sub-resources: the review history and the notes thread. */
const READS: Record<string, ContentAccess> = { review: "view", notes: "view" };

function resolveScheduledAt(value: { scheduledAt: string | { date: string; time: string; timezone: string } }): Date {
  if (typeof value.scheduledAt === "string") return new Date(value.scheduledAt);
  const { date, time, timezone } = value.scheduledAt;
  if (!isValidTimeZone(timezone)) throw new ContentError(400, "Vaqt zonasi noto'g'ri");
  return zonedToUtc(date, time, timezone);
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id, action } = await params;
  const access = ACTIONS[action];
  if (!access) return jsonError("Not found", 404);
  const auth = await requireContent(access);
  if (!auth.ok) return auth.response;
  const ws = auth.ctx.workspaceId;
  const body = (await readJson(request)) ?? {};

  switch (action) {
    case "schedule": {
      const parsed = parseBody(scheduleInputSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => schedulePost(ws, id, resolveScheduledAt(parsed.data))));
    }
    case "move": {
      const parsed = parseBody(scheduleInputSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => movePost(ws, id, resolveScheduledAt(parsed.data), { canSchedule: canContent(auth.ctx.role, "content.schedule") })));
    }
    case "publish-now":
      return respond(await run(() => publishNow(ws, id)));
    case "pause":
      return respond(await run(() => pausePost(ws, id)));
    case "resume":
      return respond(await run(() => resumePost(ws, id)));
    case "unschedule":
      return respond(await run(() => unschedulePost(ws, id)));
    case "retry":
      return respond(await run(() => retryPost(ws, id)));
    case "cancel":
      return respond(await run(() => cancelPost(ws, id)));
    case "mark-published":
      return respond(await run(() => markPublishedManually(ws, id)));
    case "review": {
      const parsed = parseBody(reviewSubmitSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => submitForReview(ws, id, auth.ctx.userId, { ...parsed.data, scheduledAt: resolveScheduledAt(parsed.data) })));
    }
    case "decision": {
      const parsed = parseBody(reviewDecisionSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => decide(ws, id, auth.ctx.userId, auth.ctx.role, parsed.data)));
    }
    case "notes": {
      const parsed = parseBody(noteInputSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => addNote(ws, id, auth.ctx.userId, parsed.data.body)), 201);
    }
    case "duplicate": {
      const parsed = parseBody(duplicateInputSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => duplicatePost(ws, id, parsed.data)), 201);
    }
    case "recur": {
      const parsed = parseBody(recurInputSchema, body);
      if (!parsed.ok) return respond(parsed);
      return respond(await run(() => recurPost(ws, id, parsed.data)));
    }
    case "queue":
      return respond(await run(() => queuePost(ws, id)));
    case "delete-series-future":
      return respond(await run(() => deleteSeriesFuture(ws, id)));
    case "apply-to-series":
      return respond(await run(() => applyToSeries(ws, id)));
    default:
      return jsonError("Not found", 404);
  }
}

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id, action } = await params;
  const access = READS[action];
  if (!access) return jsonError("Not found", 404);
  const auth = await requireContent(access);
  if (!auth.ok) return auth.response;
  const ws = auth.ctx.workspaceId;
  if (action === "review") return respond(await run(() => getReviewSummary(ws, id)));
  return respond(await run(() => listNotes(ws, id)));
}
