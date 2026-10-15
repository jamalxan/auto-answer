/**
 * Which `config` keys an integration PATCH may change. Anything that decides
 * where requests (and credentials) are sent — amoCRM `subdomain` / `zone` — is
 * fixed at creation and cannot be patched.
 */

import { z } from "zod";

const amoConfigPatch = z
  .object({
    pipelineId: z.number().int().optional(),
    statusId: z.number().int().optional(),
    responsibleUserId: z.number().int().optional(),
    campaignTag: z.boolean().optional(),
    igUsernameFieldId: z.number().int().optional(),
    leadNameTemplate: z.string().max(255).optional(),
  })
  .strict();

const bitrixConfigPatch = z
  .object({
    assignedById: z.number().int().optional(),
    sourceId: z.string().max(50).optional(),
  })
  .strict();

/** The validated config patch, or null when it holds a key this type may not change. */
export function parseConfigPatch(
  type: string,
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const schema =
    type === "AMOCRM" ? amoConfigPatch : type === "BITRIX24" ? bitrixConfigPatch : z.object({}).strict();
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
