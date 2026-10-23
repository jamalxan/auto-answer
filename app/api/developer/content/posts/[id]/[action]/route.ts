import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { ContentError } from "@/lib/content/errors";
import { recurInputSchema } from "@/lib/content/recurrence";
import { applyToSeries, deleteSeriesFuture, recurPost } from "@/lib/content/series";
import { queuePost } from "@/lib/content/slots";
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
import { parseBody, readJson, requireContent, respond, type ContentAccess } from "@/lib/developer/content-guard";

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
};

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
