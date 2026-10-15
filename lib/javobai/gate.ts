/**
 * The routing gate between the webhook and the two "brains".
 *
 * For every customer DM that survived the ETAP 2/3 claims the webhook asks
 * here: OFF → production's queue, exactly as before; SHADOW → production's
 * queue plus a copy for JavobAI that only logs; LIVE → JavobAI's queue only.
 *
 * The answer is cached 30s per account (the webhook is the hot path) and
 * every failure — Redis, Postgres, a bug — ends in production's queue, so an
 * account can never go unanswered because of this module. `JAVOBAI_DISABLED=1`
 * makes every account OFF. LIVE and SHADOW also need a live AssistantProfile
 * (the knowledge base); without one the account reads as OFF.
 */

import { prisma } from "@/lib/db/client";
import { findProfile, isProfileLive } from "@/lib/assistant/profile";
import { enqueueEcho, enqueueInbound, type EchoJob, type InboundJob } from "@/lib/queue/assistant-queue";
import { isJavobAiEnabled } from "./config";
import { enqueueJavobAiEcho, enqueueJavobAiInbound } from "./queue";

export type JavobAiMode = "OFF" | "SHADOW" | "LIVE";

const GATE_TTL_MS = 30_000;
/** Our account id → { mode, expires }. */
const cache = new Map<string, { mode: JavobAiMode; expires: number }>();
/** Instagram professional id → our account id (stable, never expires). */
const accountIdByInstagramId = new Map<string, string>();
/** Ids (either kind) with no InstagramAccount row → until when that answer holds (webhooks of unknown accounts hit the gate too). */
const unknownAccounts = new Map<string, number>();

/** Drop the cached mode of one account (either id) or of every account. */
export function forgetJavobAiGate(instagramAccountId?: string) {
  if (!instagramAccountId) {
    cache.clear();
    unknownAccounts.clear();
    return;
  }
  cache.delete(instagramAccountId);
  unknownAccounts.delete(instagramAccountId);
  const mapped = accountIdByInstagramId.get(instagramAccountId);
  if (mapped) cache.delete(mapped);
}

async function resolveMode(account: { id: string; workspaceId: string }): Promise<JavobAiMode> {
  const row = await prisma.javobAiAccount.findUnique({
    where: { instagramAccountId: account.id },
    select: { mode: true },
  });
  if (!row || row.mode === "OFF") return "OFF";
  const profile = await findProfile(account.workspaceId, account.id);
  if (!profile || !isProfileLive(profile)) return "OFF";
  return row.mode;
}

async function cachedMode(where: { id: string } | { instagramId: string }): Promise<JavobAiMode> {
  if (!isJavobAiEnabled()) return "OFF";
  const key = "id" in where ? where.id : where.instagramId;
  const known = "id" in where ? where.id : accountIdByInstagramId.get(where.instagramId);
  const hit = known ? cache.get(known) : undefined;
  if (hit && hit.expires > Date.now()) return hit.mode;
  const unknownUntil = unknownAccounts.get(key);
  if (unknownUntil !== undefined) {
    if (unknownUntil > Date.now()) return "OFF";
    unknownAccounts.delete(key);
  }
  try {
    const account = await prisma.instagramAccount.findUnique({ where, select: { id: true, workspaceId: true, instagramId: true } });
    if (!account) {
      unknownAccounts.set(key, Date.now() + GATE_TTL_MS);
      return "OFF";
    }
    accountIdByInstagramId.set(account.instagramId, account.id);
    const mode = await resolveMode(account);
    cache.set(account.id, { mode, expires: Date.now() + GATE_TTL_MS });
    return mode;
  } catch (error) {
    console.error("[JavobAI] gate failed, production answers:", error instanceof Error ? error.message : error);
    return "OFF";
  }
}

/** Mode of an account by OUR row id. Cached 30s; errors and the kill switch read OFF. */
export async function getJavobAiMode(instagramAccountId: string): Promise<JavobAiMode> {
  return cachedMode({ id: instagramAccountId });
}

/** Same, by the Instagram professional id (what the webhook has). */
export async function getJavobAiModeByInstagramId(instagramId: string): Promise<JavobAiMode> {
  return cachedMode({ instagramId });
}

/**
 * The job without the attachments: their signed CDN urls are only ever used
 * by a LIVE JavobAI job (media at inbound time). Production ignores them and
 * SHADOW ignores media, so neither queue should hold the urls.
 */
function withoutAttachments(event: InboundJob): InboundJob {
  if (!("attachments" in event)) return event;
  const copy: InboundJob = { ...event };
  delete copy.attachments;
  return copy;
}

/**
 * Route one customer DM. Replaces the webhook's plain `enqueueInbound(event)`
 * and degrades to exactly that on any error.
 */
export async function routeAssistantInbound(event: InboundJob): Promise<void> {
  let mode: JavobAiMode = "OFF";
  try {
    mode = await getJavobAiModeByInstagramId(event.instagramAccountId);
  } catch {
    mode = "OFF";
  }
  const production = withoutAttachments(event);

  if (mode === "LIVE") {
    try {
      await enqueueJavobAiInbound({ ...event, shadow: false, source: "webhook" });
      return;
    } catch (error) {
      console.error("[JavobAI] LIVE enqueue failed, production answers:", error instanceof Error ? error.message : error);
      await enqueueInbound(production);
      return;
    }
  }

  await enqueueInbound(production);
  if (mode === "SHADOW") {
    try {
      await enqueueJavobAiInbound({ ...production, shadow: true, source: "webhook" });
    } catch (error) {
      console.error("[JavobAI] SHADOW enqueue failed:", error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Route one echo. Production's echo handling always runs (it sets the hard
 * mute); a LIVE account also gets JavobAI's copy, which moves a pending
 * handoff to OPERATOR_ACTIVE.
 */
export async function routeAssistantEcho(event: EchoJob): Promise<void> {
  await enqueueEcho(event);
  let mode: JavobAiMode = "OFF";
  try {
    mode = await getJavobAiModeByInstagramId(event.instagramAccountId);
  } catch {
    return;
  }
  if (mode !== "LIVE") return;
  try {
    await enqueueJavobAiEcho(event);
  } catch (error) {
    console.error("[JavobAI] echo enqueue failed:", error instanceof Error ? error.message : error);
  }
}
