/**
 * `/api/integrations/{param}`:
 *   POST   param = telegram | amocrm | bitrix24  -> create an integration
 *   PATCH  param = integration id                -> update / replace credentials
 *   DELETE param = integration id
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { isFeatureEnabled } from "@/lib/assistant/profile";
import { AmoClient, LongLivedTokenStrategy, type AmoConfig } from "@/lib/integrations/amocrm";
import { BitrixClient, isValidBitrixWebhookUrl, normalizeWebhookUrl } from "@/lib/integrations/bitrix24";
import { encryptCredentials } from "@/lib/integrations/crypto";
import { IntegrationAuthError } from "@/lib/integrations/errors";
import {
  AMO_ZONES,
  runConnectionCheck,
  serializeIntegration,
} from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ param: string }> };

const filterSchema = z.array(z.string()).max(50).optional();

const amoCreate = z.object({
  name: z.string().min(1).max(60).optional(),
  subdomain: z.string().regex(/^[a-z0-9-]{2,63}$/i, "subdomain"),
  zone: z.enum(AMO_ZONES as [string, ...string[]]).default("amocrm.ru"),
  token: z.string().min(20).max(4000),
  tokenExpiresAt: z.string().datetime().nullable().optional(),
  pipelineId: z.number().int().optional(),
  statusId: z.number().int().optional(),
  responsibleUserId: z.number().int().optional(),
  campaignTag: z.boolean().optional(),
  igUsernameFieldId: z.number().int().optional(),
  leadNameTemplate: z.string().max(255).optional(),
  igAccountFilter: filterSchema,
});

const bitrixCreate = z.object({
  name: z.string().min(1).max(60).optional(),
  webhookUrl: z.string().max(500),
  assignedById: z.number().int().optional(),
  sourceId: z.string().max(50).optional(),
  igAccountFilter: filterSchema,
});

async function validateAccounts(workspaceId: string, ids: string[] | undefined) {
  if (!ids?.length) return true;
  const count = await prisma.instagramAccount.count({ where: { workspaceId, id: { in: ids } } });
  return count === ids.length;
}

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  if (!isFeatureEnabled("integrations")) return jsonError("Integrations are disabled", 403);
  const { param } = await params;
  const body = await request.json().catch(() => ({}));
  const workspaceId = auth.ctx.workspaceId;

  if (param === "telegram") {
    const existing = await prisma.integration.findFirst({ where: { workspaceId, type: "TELEGRAM" } });
    const integration =
      existing ??
      (await prisma.integration.create({ data: { workspaceId, type: "TELEGRAM", name: "Telegram" } }));
    return jsonOk({ integration: serializeIntegration({ ...integration, telegramChats: [] }) }, existing ? 200 : 201);
  }

  if (param === "amocrm") {
    const parsed = amoCreate.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request", 400, { issues: parsed.error.issues });
    const d = parsed.data;
    if (!(await validateAccounts(workspaceId, d.igAccountFilter))) return jsonError("Instagram account not found", 404);

    const config: AmoConfig = {
      subdomain: d.subdomain.toLowerCase(),
      zone: d.zone as AmoConfig["zone"],
      pipelineId: d.pipelineId,
      statusId: d.statusId,
      responsibleUserId: d.responsibleUserId,
      campaignTag: d.campaignTag ?? true,
      igUsernameFieldId: d.igUsernameFieldId,
      leadNameTemplate: d.leadNameTemplate,
    };
    // Real request before saving anything.
    try {
      await new AmoClient(config, new LongLivedTokenStrategy(d.token), "validate").checkConnection();
    } catch (error) {
      const code = error instanceof IntegrationAuthError ? "invalid_token" : "connection_failed";
      return jsonError(code, 422, { code, detail: error instanceof Error ? error.message : undefined });
    }

    const integration = await prisma.integration.create({
      data: {
        workspaceId,
        type: "AMOCRM",
        name: d.name ?? `amoCRM · ${config.subdomain}`,
        credentialsEncrypted: encryptCredentials({ token: d.token }),
        config: JSON.parse(JSON.stringify(config)),
        igAccountFilter: d.igAccountFilter ?? [],
        tokenExpiresAt: d.tokenExpiresAt ? new Date(d.tokenExpiresAt) : null,
        lastCheckedAt: new Date(),
      },
    });
    return jsonOk({ integration: serializeIntegration(integration) }, 201);
  }

  if (param === "bitrix24") {
    const parsed = bitrixCreate.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request", 400, { issues: parsed.error.issues });
    const d = parsed.data;
    if (!isValidBitrixWebhookUrl(d.webhookUrl)) return jsonError("invalid_webhook_url", 422, { code: "invalid_webhook_url" });
    if (!(await validateAccounts(workspaceId, d.igAccountFilter))) return jsonError("Instagram account not found", 404);

    const webhookUrl = normalizeWebhookUrl(d.webhookUrl);
    try {
      await new BitrixClient(webhookUrl, {}, "validate").checkConnection();
    } catch (error) {
      const code = error instanceof IntegrationAuthError ? "invalid_webhook" : "connection_failed";
      return jsonError(code, 422, { code, detail: error instanceof Error ? error.message : undefined });
    }

    const integration = await prisma.integration.create({
      data: {
        workspaceId,
        type: "BITRIX24",
        name: d.name ?? `Bitrix24 · ${new URL(webhookUrl).hostname}`,
        credentialsEncrypted: encryptCredentials({ webhookUrl }),
        config: JSON.parse(JSON.stringify({ assignedById: d.assignedById, sourceId: d.sourceId })),
        igAccountFilter: d.igAccountFilter ?? [],
        lastCheckedAt: new Date(),
      },
    });
    return jsonOk({ integration: serializeIntegration(integration) }, 201);
  }

  return jsonError("Unknown integration type", 404);
}

const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  disabled: z.boolean().optional(),
  igAccountFilter: filterSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  // Replacing credentials re-validates against the provider.
  token: z.string().min(20).max(4000).optional(),
  tokenExpiresAt: z.string().datetime().nullable().optional(),
  webhookUrl: z.string().max(500).optional(),
});

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { param: id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);
  const d = parsed.data;

  const integration = await prisma.integration.findFirst({ where: { id, workspaceId: auth.ctx.workspaceId } });
  if (!integration) return jsonError("Not found", 404);
  if (!(await validateAccounts(auth.ctx.workspaceId, d.igAccountFilter))) return jsonError("Instagram account not found", 404);

  const data: Record<string, unknown> = {};
  if (d.name) data.name = d.name;
  if (d.igAccountFilter) data.igAccountFilter = d.igAccountFilter;
  if (d.config) data.config = { ...(integration.config as object), ...d.config };
  if (d.tokenExpiresAt !== undefined) {
    data.tokenExpiresAt = d.tokenExpiresAt ? new Date(d.tokenExpiresAt) : null;
    data.tokenWarnedAt = null;
  }
  if (d.disabled !== undefined) {
    data.status = d.disabled ? "DISABLED" : integration.status === "DISABLED" ? "ACTIVE" : integration.status;
  }
  if (d.token && integration.type === "AMOCRM") data.credentialsEncrypted = encryptCredentials({ token: d.token });
  if (d.webhookUrl && integration.type === "BITRIX24") {
    if (!isValidBitrixWebhookUrl(d.webhookUrl)) return jsonError("invalid_webhook_url", 422, { code: "invalid_webhook_url" });
    data.credentialsEncrypted = encryptCredentials({ webhookUrl: normalizeWebhookUrl(d.webhookUrl) });
  }

  const updated = await prisma.integration.update({ where: { id }, data });
  // New credentials: verify right away; if it works, held leads are released.
  if (d.token || d.webhookUrl) {
    const result = await runConnectionCheck(id);
    if (!result.ok) return jsonError(result.reason === "auth" ? "invalid_credentials" : "connection_failed", 422, { code: result.reason });
  }
  const fresh = await prisma.integration.findUniqueOrThrow({ where: { id }, include: { telegramChats: true } });
  void updated;
  return jsonOk({ integration: serializeIntegration(fresh) });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { param: id } = await params;
  const result = await prisma.integration.deleteMany({ where: { id, workspaceId: auth.ctx.workspaceId } });
  return result.count ? jsonOk({ deleted: true }) : jsonError("Not found", 404);
}
