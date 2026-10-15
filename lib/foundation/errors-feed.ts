/**
 * Recent failures of one workspace, each explained by the error catalog.
 *
 * Sources: DmLog FAILED, WebhookEvent FAILED, OperationalEvent ERROR,
 * InstagramEvent FAILED (trigger engine). Every query is filtered by
 * workspaceId; OperationalEvent rows with workspaceId = null are platform-wide
 * (worker crashes, webhook signature) and are deliberately not shown — they
 * can carry other customers' ids and text.
 */

import { prisma } from "@/lib/db/client";
import { explainError, type ExplainedError } from "./error-catalog";

export type ErrorSource = "dm" | "webhook" | "system" | "trigger";

export interface ErrorFeedItem extends ExplainedError {
  id: string;
  source: ErrorSource;
  occurredAt: string;
}

export const ERROR_FEED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PER_SOURCE = 25;

export async function loadErrorFeed(workspaceId: string, now: Date = new Date(), limit = 50): Promise<ErrorFeedItem[]> {
  const since = new Date(now.getTime() - ERROR_FEED_WINDOW_MS);

  const [dmLogs, webhooks, operational, triggerEvents] = await Promise.all([
    prisma.dmLog.findMany({
      where: { workspaceId, status: "FAILED", updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: PER_SOURCE,
      select: {
        id: true,
        errorMessage: true,
        updatedAt: true,
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.webhookEvent.findMany({
      where: { workspaceId, status: "FAILED", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: PER_SOURCE,
      select: { id: true, object: true, errorMessage: true, createdAt: true },
    }),
    prisma.operationalEvent.findMany({
      // `workspaceId` is a plain equality on a non-null string, so platform
      // rows (workspaceId null) can never match.
      where: { workspaceId, level: "ERROR", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: PER_SOURCE,
      select: { id: true, source: true, message: true, createdAt: true, resolvedAt: true },
    }),
    prisma.instagramEvent.findMany({
      where: { workspaceId, processingStatus: "FAILED", updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: PER_SOURCE,
      select: { id: true, eventType: true, error: true, errorDetail: true, updatedAt: true },
    }),
  ]);

  const items: ErrorFeedItem[] = [
    ...dmLogs.map((row) => ({
      ...explainError(row.errorMessage ?? "", {
        timestamp: row.updatedAt,
        related: {
          type: "DmLog",
          id: row.id,
          label: `${row.automation?.name ?? "Kampaniya"} · @${row.instagramAccount?.username ?? "?"}`,
        },
      }),
      id: `dm:${row.id}`,
      source: "dm" as const,
      occurredAt: row.updatedAt.toISOString(),
    })),
    ...webhooks.map((row) => ({
      ...explainError(row.errorMessage ?? "", {
        timestamp: row.createdAt,
        related: { type: "WebhookEvent", id: row.id, label: `Webhook · ${row.object ?? "?"}` },
      }),
      id: `webhook:${row.id}`,
      source: "webhook" as const,
      occurredAt: row.createdAt.toISOString(),
    })),
    ...operational
      .filter((row) => !row.resolvedAt)
      .map((row) => ({
        ...explainError(row.message, {
          timestamp: row.createdAt,
          related: { type: "OperationalEvent", id: row.id, label: row.source },
        }),
        id: `system:${row.id}`,
        source: "system" as const,
        occurredAt: row.createdAt.toISOString(),
      })),
    ...triggerEvents.map((row) => ({
      ...explainError(row.errorDetail || row.error || "", {
        timestamp: row.updatedAt,
        related: { type: "InstagramEvent", id: row.id, label: `Trigger · ${row.eventType}` },
      }),
      id: `trigger:${row.id}`,
      source: "trigger" as const,
      occurredAt: row.updatedAt.toISOString(),
    })),
  ];

  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
}
