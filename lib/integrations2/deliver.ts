/**
 * ETAP 8 — the delivery engine of the outbound bus. Mirrors
 * lib/leads/delivery.ts (lease-claim, the 30s / 2m / 10m / 1h / 6h retry
 * schedule, DEAD after 6 attempts, auth errors hold the integration) and adds
 * what the bus needs on top:
 *
 *  - per-integration rate limit (default 60/min) that reschedules WITHOUT
 *    counting an attempt, plus a per-second slot;
 *  - connector outcomes `wait` (enrichment waiting for the lead push, no
 *    attempt burnt) and `skipped`;
 *  - 410 disables the subscription; 5 consecutive DEAD deliveries do too;
 *  - a DEAD delivery raises an OperationalEvent and a Telegram/e-mail alert,
 *    throttled to one per integration per hour;
 *  - manual redeliver per delivery / per event / all DEAD.
 */

import type { Integration, IntegrationSubscription, OutboundDelivery } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { IntegrationAuthError, MAX_DELIVERY_ATTEMPTS, nextRetryDelayMs } from "@/lib/integrations/errors";
import { alertWorkspace } from "@/lib/telegram/notify";
import {
  DEAD_AUTO_DISABLE,
  DEFAULT_RATE_PER_MINUTE,
  INTEGRATION2_TYPE_LABELS,
  RETRY_AFTER_MAX_MS,
  RETENTION_DAYS,
  isOutboundBusEnabled,
  type Integration2Type,
  type OutboundEventType,
} from "./config";
import { maskSnippet } from "./events";
import { getConnector } from "./connectors";
import type { ConnectorResult } from "./connectors/types";
import { kvIncrWindow, kvSetNx } from "./kv";
import { frozenPayloadOf, materializeEvent, payloadForSubscription } from "./materialize";
import { enqueueOutboundDelivery } from "./queue";
import { readSubscriptionFilter, type SubscriptionFilter } from "./subscriptions";

/** A lease: a claimed delivery that is not finished within this window is picked up again by the sweep. */
export const LEASE_MS = 5 * 60_000;
export const RATE_WINDOW_MS = 60_000;
/** At most this many sends per second per integration (smooths bursts below the per-minute limit). */
export const PER_SECOND_LIMIT = 10;

export type ProcessOutcome =
  | "sent"
  | "retry"
  | "dead"
  | "held"
  | "rescheduled"
  | "waiting"
  | "skipped"
  | "noop";

export interface ProcessResult {
  outcome: ProcessOutcome;
  deliveryId: string;
}

const clip = (text: string | null | undefined, max = 500) => (text ?? "").slice(0, max);

function rateLimitOf(integration: Integration): number {
  const value = (integration.config as { rateLimitPerMinute?: unknown } | null)?.rateLimitPerMinute;
  return typeof value === "number" && value >= 1 ? Math.floor(value) : DEFAULT_RATE_PER_MINUTE;
}

async function secondSlot(integrationId: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const count = await kvIncrWindow(`integrations2:sec:${integrationId}`, 1);
    if (count <= PER_SECOND_LIMIT) return;
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 5));
  }
}

// ─── Integration state ────────────────────────────────────────────────────────

function labelOf(integration: Integration): string {
  return integration.type in INTEGRATION2_TYPE_LABELS
    ? INTEGRATION2_TYPE_LABELS[integration.type as Integration2Type]
    : integration.type === "AMOCRM"
      ? "amoCRM"
      : integration.type === "BITRIX24"
        ? "Bitrix24"
        : "Telegram";
}

/** BROKEN + OperationalEvent + alert. Own copy of the lead pipeline's helper: its alert text names Telegram/amoCRM/Bitrix24 only. */
export async function markOutboundBroken(integration: Integration, message: string): Promise<void> {
  if (integration.status === "BROKEN") return;
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "BROKEN", lastError: clip(message), lastCheckedAt: new Date() },
  });
  await prisma.operationalEvent.create({
    data: {
      workspaceId: integration.workspaceId,
      source: "SYSTEM",
      level: "ERROR",
      message: clip(`${integration.name} integratsiyasi to'xtadi: ${message}`),
      payload: { integrationId: integration.id, type: integration.type, bus: true },
    },
  });
  const label = labelOf(integration);
  await alertWorkspace(
    integration.workspaceId,
    `${label} integratsiyasi to'xtadi`,
    `⚠️ <b>${label}: ${integration.name} to'xtadi</b>\n${clip(maskSnippet(message), 300)}\nTuzatgach «Ulanishni tekshirish»ni bosing — kutayotgan hodisalar avtomatik yuboriladi.`,
    `${label} (${integration.name}) integratsiyasi to'xtadi: ${message}. Tuzatgach ulanishni tekshiring — kutayotgan hodisalar avtomatik yuboriladi.`
  ).catch(() => {});
}

/** Put every held delivery of a repaired integration back in the queue. */
export async function resumeOutboundIntegration(integrationId: string): Promise<number> {
  const held = await prisma.outboundDelivery.findMany({
    where: { integrationId, status: { in: ["PENDING", "FAILED"] } },
    select: { id: true },
  });
  for (const { id } of held) {
    await prisma.outboundDelivery.update({ where: { id }, data: { nextAttemptAt: new Date() } });
    await enqueueOutboundDelivery(id, 0, `r${Date.now()}`);
  }
  return held.length;
}

// ─── Result handling ──────────────────────────────────────────────────────────

type DeliveryRow = OutboundDelivery & { integration: Integration };

function evidence(result: ConnectorResult) {
  return {
    responseCode: result.responseCode ?? null,
    responseSnippet: result.responseSnippet ? maskSnippet(result.responseSnippet) : null,
    signature: result.signature ?? null,
    durationMs: result.durationMs ?? null,
  };
}

async function disableSubscription(subscriptionId: string | null, integration: Integration, reason: string): Promise<void> {
  if (!subscriptionId) return;
  const subscription = await prisma.integrationSubscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription?.active) return;
  await prisma.integrationSubscription.update({ where: { id: subscriptionId }, data: { active: false } });
  await prisma.operationalEvent.create({
    data: {
      workspaceId: integration.workspaceId,
      source: "SYSTEM",
      level: "WARNING",
      message: clip(`${integration.name}: «${subscription.eventType}» obunasi o'chirildi — ${reason}`),
      payload: { integrationId: integration.id, subscriptionId, eventType: subscription.eventType, bus: true },
    },
  });
}

async function onDead(delivery: DeliveryRow, note: string, disable: boolean): Promise<void> {
  const { integration } = delivery;
  await prisma.operationalEvent.create({
    data: {
      workspaceId: integration.workspaceId,
      source: "SYSTEM",
      level: "ERROR",
      message: clip(`${integration.name}: hodisa yetkazilmadi — ${note}`),
      payload: { integrationId: integration.id, deliveryId: delivery.id, eventId: delivery.eventId, bus: true },
    },
  });

  if (disable) {
    await disableSubscription(delivery.subscriptionId, integration, "qabul qiluvchi 410 Gone qaytardi");
  } else if (delivery.subscriptionId) {
    const recent = await prisma.outboundDelivery.findMany({
      where: { subscriptionId: delivery.subscriptionId },
      orderBy: { createdAt: "desc" },
      take: DEAD_AUTO_DISABLE,
      select: { status: true },
    });
    if (recent.length >= DEAD_AUTO_DISABLE && recent.every((r) => r.status === "DEAD")) {
      await disableSubscription(delivery.subscriptionId, integration, `${DEAD_AUTO_DISABLE} ta ketma-ket yetkazilmadi`);
    }
  }

  // One alert per integration per hour: a dead receiver must not flood the chat.
  if (await kvSetNx(`integrations2:deadalert:${integration.id}`, 3600)) {
    const label = labelOf(integration);
    await alertWorkspace(
      integration.workspaceId,
      `${label}: hodisa yetkazilmadi`,
      `❌ <b>${label}: hodisa yetkazilmadi</b> (${integration.name})\n${clip(maskSnippet(note), 250)}\nDeveloper → Integrations → Deliveries'da «Qayta yuborish»ni bosing.`,
      `${label} (${integration.name}) ga hodisa yetkazilmadi: ${note}. Deliveries bo'limida qayta yuboring. Bir soat ichida boshqa shunday xabarlar alohida yuborilmaydi.`
    ).catch(() => {});
  }
}

async function finishDead(delivery: DeliveryRow, note: string, result: ConnectorResult | null, attempts: number, disable = false) {
  await prisma.outboundDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "DEAD",
      attempts,
      nextAttemptAt: null,
      lastError: clip(note),
      ...(result ? evidence(result) : {}),
    },
  });
  await onDead(delivery, note, disable);
}

// ─── Processing ───────────────────────────────────────────────────────────────

export async function processOutboundDelivery(deliveryId: string): Promise<ProcessResult> {
  const noop = (outcome: ProcessOutcome = "noop"): ProcessResult => ({ outcome, deliveryId });
  if (!isOutboundBusEnabled()) return noop();

  const delivery = (await prisma.outboundDelivery.findUnique({
    where: { id: deliveryId },
    include: { integration: true },
  })) as DeliveryRow | null;
  if (!delivery || delivery.status === "SENT" || delivery.status === "DEAD" || delivery.status === "SKIPPED") return noop();

  const { integration } = delivery;
  if (integration.status !== "ACTIVE") {
    // Held until the integration is repaired (resumeOutboundIntegration).
    await prisma.outboundDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: null } });
    return noop("held");
  }

  // Not due yet (a stale queue job fired early): leave it, and do not spend rate-limit quota on it.
  if (delivery.nextAttemptAt && delivery.nextAttemptAt.getTime() > Date.now()) return noop();

  // Per-integration rate limit: over it → try again in a minute, no attempt counted.
  const limit = rateLimitOf(integration);
  const used = await kvIncrWindow(`integrations2:rate:${integration.id}`, RATE_WINDOW_MS / 1000);
  if (used > limit) {
    await prisma.outboundDelivery.updateMany({
      where: { id: delivery.id, status: { in: ["PENDING", "FAILED"] } },
      data: { nextAttemptAt: new Date(Date.now() + RATE_WINDOW_MS), lastError: `Tezlik limiti (${limit}/daqiqa) — 1 daqiqadan keyin` },
    });
    await enqueueOutboundDelivery(delivery.id, RATE_WINDOW_MS, `rl${Date.now()}`);
    return noop("rescheduled");
  }

  // Lease: a retry job and the sweeper can both fire; only the winner of this update sends.
  const now = new Date();
  const claimed = await prisma.outboundDelivery.updateMany({
    where: {
      id: delivery.id,
      status: { in: ["PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) return noop();

  const event = await prisma.outboundEvent.findUnique({ where: { id: delivery.eventId } });
  const frozen = event ? frozenPayloadOf(event.payload) : null;
  if (!event || !frozen) {
    await finishDead(delivery, "Hodisa payload'i topilmadi (muddati o'tgan yoki o'chirilgan)", null, delivery.attempts + 1);
    return noop("dead");
  }

  const subscription: IntegrationSubscription | null = delivery.subscriptionId
    ? await prisma.integrationSubscription.findUnique({ where: { id: delivery.subscriptionId } })
    : null;
  const filter: SubscriptionFilter = subscription ? readSubscriptionFilter(subscription.filter) : { v: 1, include_test: true };

  await secondSlot(integration.id);

  let result: ConnectorResult;
  try {
    result = await getConnector(integration.type).send({
      integration,
      delivery: { id: delivery.id, attempts: delivery.attempts, createdAt: delivery.createdAt },
      event: { id: event.id, type: event.type as OutboundEventType, workspaceId: event.workspaceId },
      payload: payloadForSubscription(frozen, filter),
      filter,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result =
      error instanceof IntegrationAuthError
        ? { outcome: "auth", note: message }
        : { outcome: "retry", note: maskSnippet(message, 300), responseSnippet: maskSnippet(message) };
  }

  const attempts = delivery.attempts + 1;
  switch (result.outcome) {
    case "sent":
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          attempts,
          sentAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
          externalId: result.externalId ?? null,
          externalUrl: result.externalUrl ?? null,
          ...evidence(result),
        },
      });
      return noop("sent");

    case "skipped":
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { status: "SKIPPED", nextAttemptAt: null, lastError: clip(result.note), externalId: result.externalId ?? null, externalUrl: result.externalUrl ?? null },
      });
      return noop("skipped");

    case "wait": {
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { nextAttemptAt: new Date(Date.now() + result.delayMs), lastError: clip(result.note) },
      });
      await enqueueOutboundDelivery(delivery.id, result.delayMs, `w${Date.now()}`);
      return noop("waiting");
    }

    case "auth":
      // Credentials / sharing are wrong: stop, keep the delivery pending, flag the integration.
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { nextAttemptAt: null, lastError: clip(result.note), ...evidence(result) },
      });
      await markOutboundBroken(integration, result.note);
      return noop("held");

    case "dead":
      await finishDead(delivery, result.note, result, attempts, Boolean(result.disableSubscription));
      return noop("dead");

    case "retry": {
      const scheduled = nextRetryDelayMs(attempts);
      if (scheduled === null) {
        await finishDead(delivery, `${MAX_DELIVERY_ATTEMPTS} urinishdan keyin ham yetkazilmadi: ${result.note}`, result, attempts);
        return noop("dead");
      }
      const delay = Math.min(result.retryAfterMs ?? scheduled, RETRY_AFTER_MAX_MS);
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", attempts, lastError: clip(result.note), nextAttemptAt: new Date(Date.now() + delay), ...evidence(result) },
      });
      await enqueueOutboundDelivery(delivery.id, delay, attempts);
      return noop("retry");
    }
  }
}

// ─── Manual redelivery ────────────────────────────────────────────────────────

export interface RedeliverResult {
  queued: boolean;
  reason?: "not_found" | "integration_inactive";
}

/** Reset one delivery and queue it again (any state; the caller scopes the id to its workspace). */
export async function redeliver(deliveryId: string): Promise<RedeliverResult> {
  const delivery = await prisma.outboundDelivery.findUnique({ where: { id: deliveryId }, include: { integration: true } });
  if (!delivery) return { queued: false, reason: "not_found" };
  if (delivery.integration.status !== "ACTIVE") return { queued: false, reason: "integration_inactive" };
  await prisma.outboundDelivery.update({
    where: { id: delivery.id },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  await enqueueOutboundDelivery(delivery.id, 0, `m${Date.now()}`);
  return { queued: true };
}

export async function redeliverEvent(eventId: string): Promise<number> {
  const deliveries = await prisma.outboundDelivery.findMany({ where: { eventId }, select: { id: true } });
  let queued = 0;
  for (const { id } of deliveries) if ((await redeliver(id)).queued) queued++;
  return queued;
}

/** "Redeliver all DEAD" of a workspace (optionally one integration). Capped so one click cannot flood a receiver. */
export async function redeliverAllDead(workspaceId: string, integrationId?: string, limit = 500): Promise<number> {
  const dead = await prisma.outboundDelivery.findMany({
    where: { status: "DEAD", integration: { workspaceId }, ...(integrationId ? { integrationId } : {}) },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let queued = 0;
  for (const { id } of dead) if ((await redeliver(id)).queued) queued++;
  return queued;
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Safety net run by the worker: anything due (including a lease that expired
 * because the worker died mid-send) that has no live queue job is queued again.
 */
export async function sweepDueOutbound(limit = 200, now = new Date()): Promise<number> {
  const due = await prisma.outboundDelivery.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { not: null, lte: new Date(now.getTime() - 60_000) },
      integration: { status: "ACTIVE" },
    },
    select: { id: true },
    take: limit,
  });
  for (const { id } of due) await enqueueOutboundDelivery(id, 0, `s${Math.floor(now.getTime() / 60_000)}`);
  return due.length;
}

/** Events whose materialise job was lost (Redis flush, crash) are materialised right here. */
export async function sweepUnmaterialized(limit = 50, now = new Date()): Promise<number> {
  const stale = await prisma.outboundEvent.findMany({
    where: { materializedAt: null, createdAt: { lte: new Date(now.getTime() - 60_000) } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of stale) await materializeEvent(id).catch((error) => console.error("[Integrations] materialise failed:", error));
  return stale.length;
}

/** Events and deliveries older than RETENTION_DAYS are purged (payloads hold phone numbers). */
export async function purgeOldOutbound(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3_600_000);
  await prisma.outboundDelivery.deleteMany({ where: { event: { createdAt: { lt: cutoff } } } });
  const events = await prisma.outboundEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return events.count;
}
