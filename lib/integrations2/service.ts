/**
 * ETAP 8 — the developer API's service layer (routes in
 * app/api/connectors). Every function takes the caller's
 * workspace id, scopes every lookup to it (foreign ids are 404), never
 * returns credentials, and answers `{ ok, data } | { ok: false, status, error }`
 * with Uzbek messages: 400 bad body, 404 foreign id, 422 business rule.
 */

import { randomUUID } from "node:crypto";
import type { Integration, IntegrationType, OutboundDelivery, OutboundEvent } from "@/app/generated/prisma/client";
import { z } from "zod";
import { done, fail, type ServiceResult } from "@/lib/crm/result";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { AmoClient, LongLivedTokenStrategy, type AmoConfig } from "@/lib/integrations/amocrm";
import { BitrixClient, type BitrixConfig } from "@/lib/integrations/bitrix24";
import { decryptCredentials, encryptCredentials } from "@/lib/integrations/crypto";
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS } from "@/lib/integrations/errors";
import {
  DEAD_AUTO_DISABLE,
  DEFAULT_RATE_PER_MINUTE,
  INTEGRATION2_TYPES,
  INTEGRATION2_TYPE_LABELS,
  OUTBOUND_EVENT_INFO,
  OUTBOUND_EVENT_TYPES,
  RETENTION_DAYS,
  SECRET_OVERLAP_HOURS,
  isOutboundBusEnabled,
  type OutboundEventType,
} from "./config";
import { getConnector } from "./connectors";
import { ENRICH_EVENT_TYPES, enrichConfigSchema, readEnrichConfig } from "./connectors/enrichment";
import { readSheetsConfig } from "./connectors/sheets";
import { parseServiceAccountJson, parseSpreadsheetId } from "./connectors/sheets-auth";
import { DEFAULT_SHEET_NAME, SHEET_HEADERS } from "./connectors/sheets-rows";
import { HOT_EVENT_TYPES } from "./connectors/telegram-hot";
import { readWebhookConfig } from "./connectors/webhook";
import { processOutboundDelivery, redeliver, redeliverAllDead, resumeOutboundIntegration } from "./deliver";
import { buildEventPayload, materializeEvent } from "./materialize";
import { outboundPayloadV1Schema, sampleEvent, type OutboundPayloadV1 } from "./events";
import { previewSample } from "./payload-preview";
import {
  activePreviousSecret,
  encryptWebhookSecret,
  readSheetsCredentials,
  readWebhookCredentials,
  rotateWebhookSecret,
  secretHintOf,
} from "./secrets";
import { generateWebhookSecret } from "./signing";
import {
  describeFilter,
  readSubscriptionFilter,
  subscriptionFilterSchema,
  type SubscriptionFilter,
} from "./subscriptions";
import { assertOutboundUrl, presetHint, type UrlPolicyOptions } from "./url-policy";

export const NOT_FOUND = "Integratsiya topilmadi";
export const DELIVERY_NOT_FOUND = "Yetkazish topilmadi";
const BUS_OFF = "Hodisalar shinasi o'chirilgan (INTEGRATIONS_BUS_DISABLED=1)";
const MAX_BUS_INTEGRATIONS = 20;

const BUS_TYPES = INTEGRATION2_TYPES as readonly string[];
const isBusType = (type: string) => BUS_TYPES.includes(type);
const isWebhookType = (type: string) => type === "WEBHOOK" || type === "MAKE" || type === "ZAPIER";

/** Test seam, same as the connector's. */
let policyOptions: UrlPolicyOptions = {};
export function setServicePolicyOptionsForTests(options: UrlPolicyOptions): void {
  policyOptions = options;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const eventTypeSchema = z.enum(OUTBOUND_EVENT_TYPES);

/** `{ temperatures: [...] }` without `v` is accepted and completed. */
export const filterInputSchema = z.preprocess(
  (value) => (value && typeof value === "object" && !Array.isArray(value) && !("v" in value) ? { v: 1, ...value } : value),
  subscriptionFilterSchema
);

const nameSchema = z.string().trim().min(1, "Nom kiriting").max(80, "Nom 80 belgigacha bo'lsin");

const subscriptionsInputSchema = z.object({
  events: z.array(eventTypeSchema).min(1, "Kamida bitta hodisani tanlang").max(OUTBOUND_EVENT_TYPES.length),
  filter: filterInputSchema.optional(),
});

export const webhookCreateSchema = z.object({
  name: nameSchema,
  url: z.string().trim().min(1, "URL kiriting").max(2000),
  /** WEBHOOK (default) / MAKE / ZAPIER — also the stored integration type. */
  preset: z.enum(["WEBHOOK", "MAKE", "ZAPIER"]).default("WEBHOOK"),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(DEFAULT_RATE_PER_MINUTE),
  igAccountFilter: z.array(z.string()).max(50).default([]),
  ...subscriptionsInputSchema.shape,
});

export const sheetsCreateSchema = z.object({
  name: nameSchema,
  /** The downloaded service-account key file, pasted or uploaded as text. */
  serviceAccountJson: z.string().min(20, "Kalit faylini kiriting").max(20_000),
  spreadsheet: z.string().trim().min(1, "Jadval ID yoki havolasini kiriting").max(500),
  sheetName: z.string().trim().min(1).max(100).default(DEFAULT_SHEET_NAME),
  igAccountFilter: z.array(z.string()).max(50).default([]),
  ...subscriptionsInputSchema.shape,
});

export const integrationPatchSchema = z
  .object({
    name: nameSchema.optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    spreadsheet: z.string().trim().min(1).max(500).optional(),
    sheetName: z.string().trim().min(1).max(100).optional(),
    igAccountFilter: z.array(z.string()).max(50).optional(),
  })
  .strict();

export const subscriptionsPutSchema = z.object({
  subscriptions: z
    .array(
      z.object({
        eventType: eventTypeSchema,
        filter: filterInputSchema.optional(),
        active: z.boolean().default(true),
      })
    )
    .max(OUTBOUND_EVENT_TYPES.length),
});

export const enrichmentPatchSchema = enrichConfigSchema.partial({ enabled: true, temperatureTag: true, stageMap: true }).extend({
  scoreFieldId: z.union([z.number().int().positive(), z.string().trim().min(1).max(100), z.null()]).optional(),
});

export const testSchema = z.object({ eventType: eventTypeSchema.optional() }).default({});

export const deliveriesQuerySchema = z.object({
  integrationId: z.string().min(1).optional(),
  status: z.enum(["PENDING", "SENT", "FAILED", "DEAD", "SKIPPED"]).optional(),
  type: eventTypeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const previewQuerySchema = z.object({
  type: eventTypeSchema,
  leadId: z.string().min(1).optional(),
});

// ─── Views ────────────────────────────────────────────────────────────────────

export interface SubscriptionView {
  id: string;
  eventType: string;
  filter: SubscriptionFilter;
  description: string;
  active: boolean;
}

export interface IntegrationView {
  id: string;
  type: IntegrationType;
  typeLabel: string;
  /** TELEGRAM / AMOCRM / BITRIX24: the production lead pipeline; the bus only adds subscriptions / enrichment. */
  legacy: boolean;
  name: string;
  status: string;
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  secretHint: string;
  /** Sanitised: no credentials, no tokens. */
  config: Record<string, unknown>;
  igAccountFilter: string[];
  subscriptions: SubscriptionView[];
  counts: { pending: number; dead: number; sent24h: number; leadPending: number; leadDead: number };
  previousSecretExpiresAt: string | null;
  enrichment: { enabled: boolean; scoreFieldId: string | number | null; temperatureTag: boolean; stageMap: Record<string, string | number> } | null;
}

function sanitizedConfig(integration: Integration): Record<string, unknown> {
  const config = (integration.config ?? {}) as Record<string, unknown>;
  if (isWebhookType(integration.type)) {
    const parsed = readWebhookConfig(config);
    return parsed ? { url: parsed.url, preset: parsed.preset, rateLimitPerMinute: parsed.rateLimitPerMinute } : {};
  }
  if (integration.type === "GOOGLE_SHEETS") {
    const parsed = readSheetsConfig(config);
    return parsed
      ? {
          spreadsheetId: parsed.spreadsheetId,
          sheetName: parsed.sheetName,
          clientEmail: readSheetsCredentials(integration)?.client_email ?? null,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${parsed.spreadsheetId}/edit`,
          headers: SHEET_HEADERS,
        }
      : {};
  }
  if (integration.type === "AMOCRM") return { subdomain: config.subdomain ?? null, zone: config.zone ?? null };
  return {};
}

async function viewOf(integration: Integration): Promise<IntegrationView> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [subscriptions, pending, dead, sent24h, leadPending, leadDead] = await Promise.all([
    prisma.integrationSubscription.findMany({ where: { integrationId: integration.id }, orderBy: { createdAt: "asc" } }),
    prisma.outboundDelivery.count({ where: { integrationId: integration.id, status: { in: ["PENDING", "FAILED"] } } }),
    prisma.outboundDelivery.count({ where: { integrationId: integration.id, status: "DEAD" } }),
    prisma.outboundDelivery.count({ where: { integrationId: integration.id, status: "SENT", sentAt: { gte: since } } }),
    prisma.leadDelivery.count({ where: { integrationId: integration.id, status: { in: ["PENDING", "FAILED"] } } }),
    prisma.leadDelivery.count({ where: { integrationId: integration.id, status: "DEAD" } }),
  ]);
  const webhook = isWebhookType(integration.type) ? readWebhookCredentials(integration) : null;
  const previousExpires = webhook && activePreviousSecret(webhook) ? (webhook.previousSecretExpiresAt ?? null) : null;
  const enrich = integration.type === "AMOCRM" || integration.type === "BITRIX24" ? readEnrichConfig(integration.config) : null;
  return {
    id: integration.id,
    type: integration.type,
    typeLabel:
      integration.type in INTEGRATION2_TYPE_LABELS
        ? INTEGRATION2_TYPE_LABELS[integration.type as keyof typeof INTEGRATION2_TYPE_LABELS]
        : integration.type === "AMOCRM"
          ? "amoCRM"
          : integration.type === "BITRIX24"
            ? "Bitrix24"
            : "Telegram",
    legacy: !isBusType(integration.type),
    name: integration.name,
    status: integration.status,
    lastError: integration.lastError,
    lastCheckedAt: integration.lastCheckedAt,
    createdAt: integration.createdAt,
    secretHint: secretHintOf(integration),
    config: sanitizedConfig(integration),
    igAccountFilter: integration.igAccountFilter,
    subscriptions: subscriptions.map((s) => {
      const filter = readSubscriptionFilter(s.filter);
      return { id: s.id, eventType: s.eventType, filter, description: describeFilter(filter), active: s.active };
    }),
    counts: { pending, dead, sent24h, leadPending, leadDead },
    previousSecretExpiresAt: previousExpires,
    enrichment: enrich
      ? { enabled: enrich.enabled, scoreFieldId: enrich.scoreFieldId ?? null, temperatureTag: enrich.temperatureTag, stageMap: enrich.stageMap }
      : integration.type === "AMOCRM" || integration.type === "BITRIX24"
        ? { enabled: false, scoreFieldId: null, temperatureTag: true, stageMap: {} }
        : null,
  };
}

export interface DeliveryView {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  eventId: string;
  eventType: string;
  isTest: boolean;
  occurredAt: Date | null;
  integration: { id: string; name: string; type: string } | null;
  nextAttemptAt: Date | null;
  lastError: string | null;
  responseCode: number | null;
  responseSnippet: string | null;
  signature: string | null;
  externalId: string | null;
  externalUrl: string | null;
  durationMs: number | null;
  sentAt: Date | null;
  createdAt: Date;
}

type DeliveryRow = OutboundDelivery & {
  event?: Pick<OutboundEvent, "type" | "isTest" | "occurredAt"> | null;
  integration?: Pick<Integration, "id" | "name" | "type"> | null;
};

function deliveryView(row: DeliveryRow): DeliveryView {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    eventId: row.eventId,
    eventType: row.event?.type ?? "",
    isTest: row.event?.isTest ?? false,
    occurredAt: row.event?.occurredAt ?? null,
    integration: row.integration ? { id: row.integration.id, name: row.integration.name, type: row.integration.type } : null,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    responseCode: row.responseCode,
    responseSnippet: row.responseSnippet,
    signature: row.signature,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    durationMs: row.durationMs,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  };
}

async function ownIntegration(workspaceId: string, id: string): Promise<Integration | null> {
  return prisma.integration.findFirst({ where: { id, workspaceId } });
}

// ─── List / meta ──────────────────────────────────────────────────────────────

export async function listIntegrations(workspaceId: string) {
  const integrations = await prisma.integration.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } });
  return {
    integrations: await Promise.all(integrations.map((i) => viewOf(i))),
    accounts,
    busEnabled: isOutboundBusEnabled(),
  };
}

export async function getMeta(workspaceId: string) {
  const [accounts, stages] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } }),
    prisma.crmStage.findMany({ where: { pipeline: { workspaceId } }, include: { pipeline: true }, orderBy: { sort: "asc" } }).catch(() => []),
  ]);
  return {
    busEnabled: isOutboundBusEnabled(),
    baseUrl: getBaseUrl(),
    events: OUTBOUND_EVENT_TYPES.map((type) => ({ type, ...OUTBOUND_EVENT_INFO[type] })),
    connectorTypes: INTEGRATION2_TYPES.map((type) => ({
      type,
      label: INTEGRATION2_TYPE_LABELS[type],
      events: OUTBOUND_EVENT_TYPES.filter((e) => getConnector(type).supports(e)),
    })),
    enrichment: {
      events: ENRICH_EVENT_TYPES,
      hotEvents: HOT_EVENT_TYPES,
      amo: ["Ball (custom maydon)", "hot / warm tegi", "Ball va signallar izohi", "Bosqich → status"],
      bitrix: ["Ball (UF maydon)", "Ball va harorat izohi", "Bosqich → STATUS_ID"],
    },
    limits: {
      retryDelaysSec: RETRY_DELAYS_MS.map((ms) => ms / 1000),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      deadAutoDisable: DEAD_AUTO_DISABLE,
      retentionDays: RETENTION_DAYS,
      secretOverlapHours: SECRET_OVERLAP_HOURS,
      defaultRatePerMinute: DEFAULT_RATE_PER_MINUTE,
    },
    sheetHeaders: SHEET_HEADERS,
    accounts,
    stages: stages.map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline?.name ?? "" })),
  };
}

// ─── Create ───────────────────────────────────────────────────────────────────

async function busCount(workspaceId: string): Promise<number> {
  return prisma.integration.count({ where: { workspaceId, type: { in: [...INTEGRATION2_TYPES] } } });
}

async function ownAccountsOnly(workspaceId: string, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const found = await prisma.instagramAccount.count({ where: { workspaceId, id: { in: ids } } });
  return found === ids.length ? null : "Instagram akkaunt topilmadi";
}

async function createSubscriptions(integrationId: string, events: OutboundEventType[], filter: SubscriptionFilter | undefined) {
  for (const eventType of events) {
    await prisma.integrationSubscription.create({
      data: { integrationId, eventType, filter: JSON.parse(JSON.stringify(filter ?? { v: 1 })), active: true },
    });
  }
}

export async function createWebhookIntegration(workspaceId: string, body: unknown): Promise<ServiceResult<{ integration: IntegrationView; secret: string; hint: string | null }>> {
  const parsed = webhookCreateSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const input = parsed.data;
  if ((await busCount(workspaceId)) >= MAX_BUS_INTEGRATIONS) return fail(422, `Ko'pi bilan ${MAX_BUS_INTEGRATIONS} ta ulanish yaratish mumkin`);
  const badAccount = await ownAccountsOnly(workspaceId, input.igAccountFilter);
  if (badAccount) return fail(404, badAccount);

  const policy = await assertOutboundUrl(input.url, policyOptions);
  if (!policy.ok) return fail(422, policy.reason);

  const secret = generateWebhookSecret();
  const integration = await prisma.integration.create({
    data: {
      workspaceId,
      type: input.preset,
      name: input.name,
      status: "ACTIVE",
      credentialsEncrypted: encryptWebhookSecret(secret),
      config: JSON.parse(JSON.stringify({ url: policy.url, preset: input.preset, rateLimitPerMinute: input.rateLimitPerMinute })),
      igAccountFilter: input.igAccountFilter,
    },
  });
  await createSubscriptions(integration.id, input.events, input.filter);
  return done({ integration: await viewOf(integration), secret, hint: presetHint(policy.url, input.preset) });
}

export async function createSheetsIntegration(workspaceId: string, body: unknown): Promise<ServiceResult<{ integration: IntegrationView; clientEmail: string }>> {
  const parsed = sheetsCreateSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const input = parsed.data;
  if ((await busCount(workspaceId)) >= MAX_BUS_INTEGRATIONS) return fail(422, `Ko'pi bilan ${MAX_BUS_INTEGRATIONS} ta ulanish yaratish mumkin`);
  const badAccount = await ownAccountsOnly(workspaceId, input.igAccountFilter);
  if (badAccount) return fail(404, badAccount);

  const account = parseServiceAccountJson(input.serviceAccountJson);
  if (!account.ok) return fail(422, account.reason);
  const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
  if (!spreadsheetId) return fail(422, "Jadval ID yoki havolasi noto'g'ri (…/spreadsheets/d/<ID>/edit)");
  // One sheet per workspace, append-only: a second connector on the same spreadsheet + tab would double every row.
  const existing = await prisma.integration.findMany({ where: { workspaceId, type: "GOOGLE_SHEETS" } });
  if (existing.some((i) => readSheetsConfig(i.config)?.spreadsheetId === spreadsheetId && readSheetsConfig(i.config)?.sheetName === input.sheetName)) {
    return fail(422, "Bu jadval va varaq allaqachon ulangan");
  }

  const integration = await prisma.integration.create({
    data: {
      workspaceId,
      type: "GOOGLE_SHEETS",
      name: input.name,
      status: "ACTIVE",
      credentialsEncrypted: encryptCredentials({ client_email: account.account.client_email, private_key: account.account.private_key }),
      config: JSON.parse(JSON.stringify({ spreadsheetId, sheetName: input.sheetName })),
      igAccountFilter: input.igAccountFilter,
    },
  });
  await createSubscriptions(integration.id, input.events, input.filter);
  return done({ integration: await viewOf(integration), clientEmail: account.account.client_email });
}

// ─── Update / delete ──────────────────────────────────────────────────────────

export async function patchIntegration(workspaceId: string, id: string, body: unknown): Promise<ServiceResult<IntegrationView>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (!isBusType(integration.type)) return fail(422, "Telegram, amoCRM va Bitrix24 eski Integratsiyalar bo'limida o'zgartiriladi");
  const parsed = integrationPatchSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const input = parsed.data;

  const data: Record<string, unknown> = {};
  const config = { ...((integration.config ?? {}) as Record<string, unknown>) };
  if (input.name !== undefined) data.name = input.name;
  if (input.igAccountFilter !== undefined) {
    const bad = await ownAccountsOnly(workspaceId, input.igAccountFilter);
    if (bad) return fail(404, bad);
    data.igAccountFilter = input.igAccountFilter;
  }
  if (isWebhookType(integration.type)) {
    if (input.url !== undefined) {
      const policy = await assertOutboundUrl(input.url, policyOptions);
      if (!policy.ok) return fail(422, policy.reason);
      config.url = policy.url;
    }
    if (input.rateLimitPerMinute !== undefined) config.rateLimitPerMinute = input.rateLimitPerMinute;
    if (input.spreadsheet !== undefined || input.sheetName !== undefined) return fail(422, "Bu maydonlar Webhook uchun emas");
  } else {
    if (input.url !== undefined || input.rateLimitPerMinute !== undefined) return fail(422, "Bu maydonlar Google Sheets uchun emas");
    if (input.spreadsheet !== undefined) {
      const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
      if (!spreadsheetId) return fail(422, "Jadval ID yoki havolasi noto'g'ri");
      config.spreadsheetId = spreadsheetId;
    }
    if (input.sheetName !== undefined) config.sheetName = input.sheetName;
  }
  data.config = JSON.parse(JSON.stringify(config));

  const reactivated = input.status === "ACTIVE" && integration.status !== "ACTIVE";
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status === "ACTIVE") data.lastError = null;
  }
  const updated = await prisma.integration.update({ where: { id: integration.id }, data });
  if (reactivated) await resumeOutboundIntegration(integration.id).catch(() => 0);
  return done(await viewOf(updated));
}

export async function deleteIntegration(workspaceId: string, id: string): Promise<ServiceResult<{ deleted: true }>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (!isBusType(integration.type)) return fail(422, "Telegram, amoCRM va Bitrix24 eski Integratsiyalar bo'limida o'chiriladi");
  await prisma.outboundDelivery.deleteMany({ where: { integrationId: integration.id } });
  await prisma.integrationSubscription.deleteMany({ where: { integrationId: integration.id } });
  await prisma.integration.delete({ where: { id: integration.id } });
  return done({ deleted: true });
}

// ─── Subscriptions / enrichment / secret ──────────────────────────────────────

export async function putSubscriptions(workspaceId: string, id: string, body: unknown): Promise<ServiceResult<IntegrationView>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  const parsed = subscriptionsPutSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const connector = getConnector(integration.type);
  const seen = new Set<string>();
  for (const s of parsed.data.subscriptions) {
    if (!connector.supports(s.eventType)) return fail(422, `«${OUTBOUND_EVENT_INFO[s.eventType].label}» hodisasi bu ulanish turiga mos kelmaydi`);
    if (seen.has(s.eventType)) return fail(400, `«${s.eventType}» ikki marta berilgan`);
    seen.add(s.eventType);
    if (integration.type === "AMOCRM" || integration.type === "BITRIX24") {
      if (!(ENRICH_EVENT_TYPES as readonly string[]).includes(s.eventType)) return fail(422, "amoCRM / Bitrix24 faqat boyitish hodisalarini oladi");
    }
    if (integration.type === "TELEGRAM" && !(HOT_EVENT_TYPES as readonly string[]).includes(s.eventType)) {
      return fail(422, "Telegram faqat lead.created / lead.hot (HOT karta) hodisalarini oladi");
    }
  }

  const existing = await prisma.integrationSubscription.findMany({ where: { integrationId: integration.id } });
  for (const row of existing) {
    if (!seen.has(row.eventType)) await prisma.integrationSubscription.delete({ where: { id: row.id } });
  }
  for (const s of parsed.data.subscriptions) {
    const filter = JSON.parse(JSON.stringify(s.filter ?? { v: 1 }));
    const row = existing.find((e) => e.eventType === s.eventType);
    if (row) await prisma.integrationSubscription.update({ where: { id: row.id }, data: { filter, active: s.active } });
    else await prisma.integrationSubscription.create({ data: { integrationId: integration.id, eventType: s.eventType, filter, active: s.active } });
  }
  return done(await viewOf(integration));
}

export async function patchEnrichment(workspaceId: string, id: string, body: unknown): Promise<ServiceResult<IntegrationView>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (integration.type !== "AMOCRM" && integration.type !== "BITRIX24") return fail(422, "Boyitish faqat amoCRM va Bitrix24 uchun");
  const parsed = enrichmentPatchSchema.safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const patch = parsed.data;
  const current = readEnrichConfig(integration.config) ?? { enabled: false, temperatureTag: true, stageMap: {} as Record<string, string | number>, scoreFieldId: undefined };
  const next = {
    enabled: patch.enabled ?? current.enabled,
    temperatureTag: patch.temperatureTag ?? current.temperatureTag,
    stageMap: patch.stageMap ?? current.stageMap,
    scoreFieldId: patch.scoreFieldId === null ? undefined : (patch.scoreFieldId ?? current.scoreFieldId),
  };
  if (typeof next.scoreFieldId === "string" && integration.type === "AMOCRM") return fail(422, "amoCRM uchun ball maydoni raqamli ID bo'lishi kerak");
  if (typeof next.scoreFieldId === "number" && integration.type === "BITRIX24") return fail(422, "Bitrix24 uchun ball maydoni UF_CRM_… kodi bo'lishi kerak");

  const config = { ...((integration.config ?? {}) as Record<string, unknown>), enrich: JSON.parse(JSON.stringify(next)) };
  const updated = await prisma.integration.update({ where: { id: integration.id }, data: { config } });

  // Enrichment is a subscription to the three CRM events: on while enabled, off otherwise.
  const rows = await prisma.integrationSubscription.findMany({ where: { integrationId: integration.id } });
  for (const eventType of ENRICH_EVENT_TYPES) {
    const row = rows.find((r) => r.eventType === eventType);
    if (row) await prisma.integrationSubscription.update({ where: { id: row.id }, data: { active: next.enabled } });
    else if (next.enabled) await prisma.integrationSubscription.create({ data: { integrationId: integration.id, eventType, filter: { v: 1 }, active: true } });
  }
  return done(await viewOf(updated));
}

export async function rotateSecret(workspaceId: string, id: string): Promise<ServiceResult<{ secret: string; previousSecretExpiresAt: Date }>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (!isWebhookType(integration.type)) return fail(422, "Maxfiy kalit faqat Webhook / Make / Zapier uchun");
  const credentials = readWebhookCredentials(integration);
  if (!credentials) return fail(422, "Joriy maxfiy kalit o'qilmadi — integratsiyani qayta yarating");
  const rotation = rotateWebhookSecret(credentials);
  await prisma.integration.update({ where: { id: integration.id }, data: { credentialsEncrypted: rotation.encrypted } });
  return done({ secret: rotation.secret, previousSecretExpiresAt: rotation.previousSecretExpiresAt });
}

// ─── Test / emit-test ─────────────────────────────────────────────────────────

async function createSyntheticEvent(workspaceId: string, type: OutboundEventType, hint: Record<string, unknown>) {
  const account = await prisma.instagramAccount.findFirst({ where: { workspaceId }, select: { id: true } });
  return prisma.outboundEvent.create({
    data: {
      workspaceId,
      type,
      subjectType: "test",
      subjectId: `test_${randomUUID()}`,
      instagramAccountId: account?.id ?? null,
      isTest: true,
      payload: JSON.parse(JSON.stringify({ hint: { ...hint, synthetic: true } })),
      dedupeKey: `test:${randomUUID()}`,
      occurredAt: new Date(),
    },
  });
}

/** A synthetic is_test event through the real pipeline (materialise → deliver), for one integration. Returns the delivery. */
export async function testIntegration(workspaceId: string, id: string, body: unknown): Promise<ServiceResult<{ delivery: DeliveryView; eventId: string }>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (!isOutboundBusEnabled()) return fail(422, BUS_OFF);
  const parsed = testSchema.safeParse(body ?? {});
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  if (integration.type === "AMOCRM" || integration.type === "BITRIX24") {
    return fail(422, "amoCRM / Bitrix24 boyitishini sinash uchun haqiqiy lead kerak: lead yuborilgach u o'zi ishga tushadi");
  }
  if (integration.status !== "ACTIVE") return fail(422, "Integratsiya faol emas — avval «Ulanishni tekshirish»ni bosing yoki yoqing");

  const connector = getConnector(integration.type);
  const type: OutboundEventType = parsed.data.eventType ?? (integration.type === "TELEGRAM" ? "lead.hot" : "lead.created");
  if (!connector.supports(type)) return fail(422, `«${OUTBOUND_EVENT_INFO[type].label}» hodisasi bu ulanishga mos kelmaydi`);

  const event = await createSyntheticEvent(workspaceId, type, { onlyIntegrationId: integration.id });
  await materializeEvent(event.id);
  const delivery = await prisma.outboundDelivery.findFirst({ where: { eventId: event.id, integrationId: integration.id } });
  if (!delivery) return fail(422, "Test hodisa yaratilmadi — Instagram akkaunt filtrini tekshiring");
  await processOutboundDelivery(delivery.id);
  const fresh = await prisma.outboundDelivery.findUnique({ where: { id: delivery.id }, include: { integration: true, event: true } });
  return done({ delivery: deliveryView(fresh as DeliveryRow), eventId: event.id });
}

/** A synthetic is_test event to every matching subscription (those with include_test only). */
export async function emitTestEvent(workspaceId: string, body: unknown): Promise<ServiceResult<{ eventId: string; matched: number; deliveries: number }>> {
  if (!isOutboundBusEnabled()) return fail(422, BUS_OFF);
  const parsed = z.object({ type: eventTypeSchema }).safeParse(body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const event = await createSyntheticEvent(workspaceId, parsed.data.type, {});
  const result = await materializeEvent(event.id);
  return done({ eventId: event.id, matched: result.matched ?? 0, deliveries: result.deliveries });
}

// ─── Events / preview ─────────────────────────────────────────────────────────

export async function listEvents(workspaceId: string, limit = 30) {
  const rows = await prisma.outboundEvent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: { deliveries: { select: { status: true } } },
  });
  return {
    catalogue: OUTBOUND_EVENT_TYPES.map((type) => {
      const sample = previewSample(type, getBaseUrl());
      return { type, ...OUTBOUND_EVENT_INFO[type], sample: sample.ok ? sample.json : JSON.stringify(sampleEvent(type), null, 2) };
    }),
    recent: rows.map((e) => {
      const deliveries = (e as unknown as { deliveries?: Array<{ status: string }> }).deliveries ?? [];
      return {
        id: e.id,
        type: e.type,
        subjectType: e.subjectType,
        isTest: e.isTest,
        occurredAt: e.occurredAt,
        materializedAt: e.materializedAt,
        deliveries: deliveries.length,
        sent: deliveries.filter((d) => d.status === "SENT").length,
        dead: deliveries.filter((d) => d.status === "DEAD").length,
      };
    }),
  };
}

export async function previewEventPayload(
  workspaceId: string,
  query: unknown
): Promise<ServiceResult<{ source: "lead" | "sample"; json: string; payload: OutboundPayloadV1 }>> {
  const parsed = previewQuerySchema.safeParse(query);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const { type, leadId } = parsed.data;
  if (!leadId) {
    const sample = previewSample(type, getBaseUrl());
    if (!sample.ok) return fail(422, sample.issues.join("; "));
    return done({ source: "sample", json: sample.json, payload: sample.payload });
  }
  if (!type.startsWith("lead.")) return fail(422, "leadId faqat lead hodisalari uchun");
  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId }, select: { id: true, instagramAccountId: true } });
  if (!lead) return fail(404, "Lead topilmadi");
  const built = await buildEventPayload({
    id: "evt_preview",
    workspaceId,
    type,
    subjectType: "lead",
    subjectId: lead.id,
    instagramAccountId: lead.instagramAccountId,
    isTest: false,
    occurredAt: new Date(),
    payload: null,
  });
  if (!built) return fail(422, "Lead ma'lumotlarini yig'ib bo'lmadi");
  const checked = outboundPayloadV1Schema.safeParse(built.payload);
  if (!checked.success) return fail(422, checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return done({ source: "lead", json: JSON.stringify(checked.data, null, 2), payload: checked.data });
}

// ─── Deliveries ───────────────────────────────────────────────────────────────

export async function listDeliveries(workspaceId: string, query: unknown): Promise<ServiceResult<{ deliveries: DeliveryView[]; nextCursor: string | null }>> {
  const parsed = deliveriesQuerySchema.safeParse(query);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Noto'g'ri so'rov");
  const { integrationId, status, type, cursor, limit } = parsed.data;
  if (integrationId && !(await ownIntegration(workspaceId, integrationId))) return fail(404, NOT_FOUND);
  const rows = await prisma.outboundDelivery.findMany({
    where: {
      integration: { workspaceId },
      ...(integrationId ? { integrationId } : {}),
      ...(status ? { status } : {}),
      ...(type ? { event: { type } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 0 } : {}),
    include: { integration: { select: { id: true, name: true, type: true } }, event: { select: { type: true, isTest: true, occurredAt: true } } },
  });
  const page = rows.slice(0, limit);
  return done({
    deliveries: page.map((r) => deliveryView(r as DeliveryRow)),
    nextCursor: rows.length > limit ? rows[limit].id : null,
  });
}

export async function getDelivery(
  workspaceId: string,
  id: string,
  includePayload: boolean
): Promise<ServiceResult<{ delivery: DeliveryView; payload: unknown | null; payloadHidden: boolean }>> {
  const row = await prisma.outboundDelivery.findFirst({
    where: { id, integration: { workspaceId } },
    include: { integration: { select: { id: true, name: true, type: true } }, event: true },
  });
  if (!row) return fail(404, DELIVERY_NOT_FOUND);
  const event = (row as unknown as { event: OutboundEvent }).event;
  return done({
    delivery: deliveryView(row as DeliveryRow),
    payload: includePayload ? (event?.payload ?? null) : null,
    payloadHidden: !includePayload,
  });
}

export async function redeliverOne(workspaceId: string, id: string): Promise<ServiceResult<{ queued: true }>> {
  const row = await prisma.outboundDelivery.findFirst({ where: { id, integration: { workspaceId } }, select: { id: true } });
  if (!row) return fail(404, DELIVERY_NOT_FOUND);
  const result = await redeliver(row.id);
  if (!result.queued) {
    return fail(422, result.reason === "integration_inactive" ? "Integratsiya faol emas — avval uni tuzating yoki yoqing" : DELIVERY_NOT_FOUND);
  }
  return done({ queued: true });
}

export async function redeliverDead(workspaceId: string, body: unknown): Promise<ServiceResult<{ queued: number }>> {
  const parsed = z.object({ integrationId: z.string().min(1).optional() }).safeParse(body ?? {});
  if (!parsed.success) return fail(400, "Noto'g'ri ma'lumot");
  if (parsed.data.integrationId && !(await ownIntegration(workspaceId, parsed.data.integrationId))) return fail(404, NOT_FOUND);
  return done({ queued: await redeliverAllDead(workspaceId, parsed.data.integrationId) });
}

// ─── Connection check ─────────────────────────────────────────────────────────

/** "Ulanishni tekshirish": the connector's own check; success on a BROKEN integration repairs it and releases held deliveries. */
export async function checkConnection(workspaceId: string, id: string): Promise<ServiceResult<{ ok: boolean; message: string | null; status: string }>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  if (!isBusType(integration.type)) return fail(422, "Eski turlarni Integratsiyalar bo'limida tekshiring");
  const result = await getConnector(integration.type).check(integration);
  const wasBroken = integration.status === "BROKEN";
  const updated = await prisma.integration.update({
    where: { id: integration.id },
    data: result.ok
      ? { status: integration.status === "DISABLED" ? "DISABLED" : "ACTIVE", lastCheckedAt: new Date(), lastError: null }
      : { status: result.reason === "auth" ? "BROKEN" : integration.status, lastCheckedAt: new Date(), lastError: (result.message ?? "").slice(0, 500) },
  });
  if (result.ok && wasBroken) await resumeOutboundIntegration(integration.id).catch(() => 0);
  return done({ ok: result.ok, message: result.message ?? null, status: updated.status });
}

// ─── Enrichment options (live CRM lookups for the config UI) ──────────────────

export async function enrichmentOptions(
  workspaceId: string,
  id: string
): Promise<ServiceResult<{ fields: Array<{ id: string | number; name: string }>; statuses: Array<{ id: string | number; name: string }> }>> {
  const integration = await ownIntegration(workspaceId, id);
  if (!integration) return fail(404, NOT_FOUND);
  try {
    if (integration.type === "AMOCRM") {
      const credentials = decryptCredentials<{ token: string }>(integration.credentialsEncrypted);
      const client = new AmoClient(integration.config as unknown as AmoConfig, new LongLivedTokenStrategy(credentials.token), integration.id);
      const [fields, pipelines] = await Promise.all([client.listLeadFields(), client.listPipelines()]);
      return done({
        fields: fields.filter((f) => f.type === "numeric" || f.type === "text").map((f) => ({ id: f.id, name: f.name })),
        statuses: pipelines.flatMap((p) => p.statuses.map((s) => ({ id: s.id, name: `${p.name} › ${s.name}` }))),
      });
    }
    if (integration.type === "BITRIX24") {
      const credentials = decryptCredentials<{ webhookUrl: string }>(integration.credentialsEncrypted);
      const client = new BitrixClient(credentials.webhookUrl, integration.config as unknown as BitrixConfig, integration.id);
      const [fields, statuses] = await Promise.all([
        client.call<Record<string, { title?: string; formLabel?: string; type?: string }>>("crm.lead.fields"),
        client.call<Array<{ STATUS_ID: string; NAME: string }>>("crm.status.list", { filter: { ENTITY_ID: "STATUS" } }),
      ]);
      return done({
        fields: Object.entries(fields)
          .filter(([key]) => key.startsWith("UF_"))
          .map(([key, f]) => ({ id: key, name: f.formLabel ?? f.title ?? key })),
        statuses: statuses.map((s) => ({ id: s.STATUS_ID, name: s.NAME })),
      });
    }
  } catch (error) {
    return fail(422, `CRM'dan ma'lumot olinmadi: ${error instanceof Error ? error.message.slice(0, 160) : "xato"}`);
  }
  return fail(422, "Boyitish faqat amoCRM va Bitrix24 uchun");
}
