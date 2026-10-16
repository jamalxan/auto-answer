/**
 * ETAP 5.0 — one-off import of the four stores into CrmContact (design §1):
 *
 *   InstagramContact + TriggerConversation  (trigger engine)
 *   Conversation (+ AiConversationState)    (assistant / JavobAI)
 *   Lead (+ LeadDelivery)                   → one CrmDeal each
 *   DmLog                                   (legacy campaigns: people reached who never wrote back)
 *
 * Runs per workspace or for all, in id-keyset batches, through the same
 * monotonic upserts as the hooks and the reconciler — so it can be re-run
 * at any time and only ever adds what is missing. Listener events are not
 * emitted (silent): a backfill must not trigger assignments or tags for
 * years of history.
 */

import { prisma } from "@/lib/db/client";
import { mirrorAiState, upsertContactFromParts } from "./contacts";
import { ensureDealForLead } from "./pipeline";
import { contactFromConversation, sourceFromEventType, syncLeadRows } from "./sync";

export interface BackfillCounts {
  instagramContacts: number;
  conversations: number;
  leads: number;
  dmLogs: number;
  /** CrmContact rows in scope after the run. */
  contacts: number;
  /** CrmDeal rows in scope after the run. */
  deals: number;
}

export const BACKFILL_BATCH = 500;

function scope(workspaceId: string | null | undefined) {
  return workspaceId ? { workspaceId } : {};
}

async function eachBatch<T extends { id: string }>(
  fetch: (afterId: string | null) => Promise<T[]>,
  handle: (row: T) => Promise<void>
): Promise<number> {
  let afterId: string | null = null;
  let total = 0;
  for (;;) {
    const rows = await fetch(afterId);
    for (const row of rows) await handle(row);
    total += rows.length;
    if (rows.length < BACKFILL_BATCH) return total;
    afterId = rows[rows.length - 1].id;
  }
}

const byId = (afterId: string | null) => ({
  ...(afterId ? { id: { gt: afterId } } : {}),
});

export async function runBackfill(workspaceId?: string | null, options: { log?: boolean } = {}): Promise<BackfillCounts> {
  const where = scope(workspaceId);
  const startedAt = Date.now();

  const instagramContacts = await eachBatch(
    (afterId) => prisma.instagramContact.findMany({ where: { ...where, ...byId(afterId) }, orderBy: { id: "asc" }, take: BACKFILL_BATCH }),
    async (c) => {
      await upsertContactFromParts(
        {
          workspaceId: c.workspaceId,
          instagramAccountId: c.instagramAccountId,
          igUserId: c.igUserId,
          username: c.username,
          name: c.name,
          phoneE164: c.phone,
          email: c.email,
          source: sourceFromEventType(c.source),
          instagramContactId: c.id,
          firstInteractionAt: c.firstInteractionAt,
          interactionAt: c.lastInteractionAt,
          interaction: true,
          interactionCount: c.interactionCount,
        },
        { silent: true }
      );
    }
  );

  const conversations = await eachBatch(
    (afterId) =>
      prisma.conversation.findMany({
        where: { ...where, ...byId(afterId) },
        orderBy: { id: "asc" },
        take: BACKFILL_BATCH,
        include: { aiState: { select: { id: true } } },
      }),
    async (c) => {
      const base = contactFromConversation(c);
      await upsertContactFromParts(
        c.lastCustomerMessageAt ? { ...base, interactionAt: c.lastCustomerMessageAt, inbound: true } : base,
        { silent: true }
      );
      if (c.lastBotMessageAt) {
        await upsertContactFromParts({ ...base, interactionAt: c.lastBotMessageAt, outbound: true }, { silent: true });
      }
      if (c.aiState) await mirrorAiState(c.id, { silent: true });
    }
  );

  const leads = await eachBatch(
    (afterId) =>
      prisma.lead.findMany({
        where: { ...where, ...byId(afterId), isTest: false },
        orderBy: { id: "asc" },
        take: BACKFILL_BATCH,
        include: { deliveries: { include: { integration: { select: { type: true, name: true } } } } },
      }),
    async (lead) => {
      await ensureDealForLead(lead.id, { silent: true });
      await syncLeadRows([lead], { silent: true });
    }
  );

  const dmLogs = await eachBatch(
    (afterId) => prisma.dmLog.findMany({ where: { ...where, ...byId(afterId) }, orderBy: { id: "asc" }, take: BACKFILL_BATCH }),
    async (log) => {
      const base = {
        workspaceId: log.workspaceId,
        instagramAccountId: log.instagramAccountId,
        igUserId: log.commenterId,
        name: log.commenterName,
        source: "COMMENT" as const,
      };
      await upsertContactFromParts({ ...base, interactionAt: log.createdAt, interaction: true }, { silent: true });
      if (log.status === "SENT" && log.dmSentAt) {
        await upsertContactFromParts({ ...base, interactionAt: log.dmSentAt, outbound: true }, { silent: true });
      }
    }
  );

  const [contacts, deals] = await Promise.all([prisma.crmContact.count({ where }), prisma.crmDeal.count({ where })]);
  const counts: BackfillCounts = { instagramContacts, conversations, leads, dmLogs, contacts, deals };
  if (options.log !== false) {
    console.log(`[CRM] backfill ${workspaceId ?? "all"} done in ${Date.now() - startedAt}ms: ${JSON.stringify(counts)}`);
  }
  return counts;
}
