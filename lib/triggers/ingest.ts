/**
 * Webhook → InstagramEvent rows → queue.
 *
 * Called from the webhook route after its existing work, inside its own
 * try/catch: nothing here can change what the comment / DM / assistant paths
 * do with the same payload.
 *
 * Duplicate protection, layer one: InstagramEvent is unique per
 * (account, messageId), so a redelivered webhook hits the constraint and is
 * dropped before it reaches the queue.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { isTriggerEngineEnabled } from "./config";
import { normalizeWebhookPayload, type NormalizedInstagramEvent, type RawWebhookPayload } from "./normalize";
import { enqueueEvent } from "./queue";

export interface IngestResult {
  stored: string[];
  duplicates: number;
  skipped: number;
}

interface AccountGate {
  id: string;
  workspaceId: string;
  /** False when the account has no trigger campaign: the engine stays out. */
  engaged: boolean;
}

const GATE_TTL_MS = 30_000;
const gateCache = new Map<string, { value: AccountGate | null; expires: number }>();

/** Drop the cached gate after a campaign is created or deleted. */
export function forgetAccountGate(instagramId?: string) {
  if (instagramId) gateCache.delete(instagramId);
  else gateCache.clear();
}

async function loadAccountGate(instagramId: string): Promise<AccountGate | null> {
  const cached = gateCache.get(instagramId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { id: true, workspaceId: true, _count: { select: { triggerCampaigns: true } } },
  });
  const value = account
    ? { id: account.id, workspaceId: account.workspaceId, engaged: account._count.triggerCampaigns > 0 }
    : null;
  gateCache.set(instagramId, { value, expires: Date.now() + GATE_TTL_MS });
  return value;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/** Store one normalised event. Returns null when it was already stored. */
export async function storeEvent(
  account: { id: string; workspaceId: string },
  event: NormalizedInstagramEvent
): Promise<string | null> {
  try {
    const row = await prisma.instagramEvent.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        eventType: event.type,
        senderId: event.senderId,
        senderUsername: event.senderUsername ?? null,
        messageId: event.messageId,
        storyId: event.storyId ?? null,
        storyUrl: event.storyUrl ?? null,
        mediaId: event.mediaId ?? null,
        text: event.text,
        timestamp: event.timestamp,
        rawPayload: {
          entryId: event.instagramAccountId,
          hasAttachment: event.hasAttachment,
          item: event.raw,
        } as Prisma.InputJsonValue,
        processingStatus: "PENDING",
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

export async function ingestWebhookPayload(payload: unknown): Promise<IngestResult> {
  const result: IngestResult = { stored: [], duplicates: 0, skipped: 0 };
  if (!isTriggerEngineEnabled()) return result;

  const events = normalizeWebhookPayload(payload as RawWebhookPayload);
  for (const event of events) {
    const gate = await loadAccountGate(event.instagramAccountId);
    if (!gate || !gate.engaged) {
      result.skipped++;
      continue;
    }

    const eventId = await storeEvent(gate, event);
    if (!eventId) {
      result.duplicates++;
      continue;
    }
    result.stored.push(eventId);

    // A failed enqueue (Redis down) is not lost: the row stays PENDING and the
    // worker's sweep picks it up.
    await enqueueEvent(eventId).catch((error) => {
      console.error(
        "[Trigger Engine] enqueue failed, left for the sweep:",
        error instanceof Error ? error.message : error
      );
    });
  }
  return result;
}
