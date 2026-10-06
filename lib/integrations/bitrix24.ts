/** Bitrix24 client over an inbound webhook (https://{portal}/rest/{user}/{code}/). */

import { IntegrationAuthError, IntegrationRequestError } from "./errors";
import { acquireSlot } from "./throttle";

export interface BitrixConfig {
  assignedById?: number;
  sourceId?: string;
}

export interface BitrixLeadInput {
  title: string;
  name: string | null;
  phoneE164: string | null;
  igUsername: string | null;
  sourceDescription: string;
  comments: string | null;
}

export interface BitrixDeliveryResult {
  leadId: number;
  url: string;
  mode: "created" | "comment_on_existing";
}

const RATE_PER_SECOND = 2;
const AUTH_ERRORS = new Set([
  "INVALID_CREDENTIALS",
  "expired_token",
  "invalid_token",
  "insufficient_scope",
  "WRONG_AUTH_TYPE",
  "NO_AUTH_FOUND",
]);

export function normalizeWebhookUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function isValidBitrixWebhookUrl(url: string): boolean {
  return /^https:\/\/[^/\s]+\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(url.trim());
}

export function bitrixLeadUrl(webhookUrl: string, leadId: number): string {
  const origin = new URL(webhookUrl).origin;
  return `${origin}/crm/lead/details/${leadId}/`;
}

export class BitrixClient {
  private base: string;

  constructor(
    webhookUrl: string,
    private config: BitrixConfig,
    private throttleKey: string
  ) {
    this.base = normalizeWebhookUrl(webhookUrl);
  }

  get webhookUrl() {
    return this.base;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    await acquireSlot(`bitrix:${this.throttleKey}`, RATE_PER_SECOND);
    const response = await fetch(`${this.base}${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    let data: { result?: T; error?: string; error_description?: string } = {};
    try {
      data = await response.json();
    } catch {
      // non-JSON body
    }

    if (response.status === 401 || response.status === 403 || (data.error && AUTH_ERRORS.has(data.error))) {
      throw new IntegrationAuthError(
        "bitrix24",
        `Bitrix24 auth failed: ${data.error ?? response.status}`
      );
    }
    if (data.error === "QUERY_LIMIT_EXCEEDED" && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.call<T>(method, params, attempt + 1);
    }
    if (!response.ok || data.error) {
      throw new IntegrationRequestError(
        "bitrix24",
        response.status,
        `Bitrix24 ${method}: ${data.error ?? response.status} ${data.error_description ?? ""}`.trim()
      );
    }
    return data.result as T;
  }

  checkConnection() {
    return this.call<Record<string, unknown>>("crm.lead.fields");
  }

  async listUsers() {
    const users = await this.call<
      Array<{ ID: string; NAME?: string; LAST_NAME?: string; ACTIVE?: boolean }>
    >("user.get", { filter: { ACTIVE: true } });
    return users.map((u) => ({
      id: Number(u.ID),
      name: [u.NAME, u.LAST_NAME].filter(Boolean).join(" ") || `#${u.ID}`,
    }));
  }

  async listSources() {
    const sources = await this.call<Array<{ STATUS_ID: string; NAME: string }>>(
      "crm.status.list",
      { filter: { ENTITY_ID: "SOURCE" } }
    );
    return sources.map((s) => ({ id: s.STATUS_ID, name: s.NAME }));
  }

  /** Open lead that already has this phone (duplicate guard), or null. */
  async findOpenLeadByPhone(e164: string): Promise<number | null> {
    const found = await this.call<{ LEAD?: number[] } | []>("crm.duplicate.findbycomm", {
      type: "PHONE",
      values: [e164],
      entity_type: "LEAD",
    });
    const ids = Array.isArray(found) ? [] : (found.LEAD ?? []);
    for (const id of ids.slice(0, 5)) {
      const lead = await this.call<{ STATUS_SEMANTIC_ID?: string }>("crm.lead.get", { id });
      if (lead.STATUS_SEMANTIC_ID !== "S" && lead.STATUS_SEMANTIC_ID !== "F") return id;
    }
    return null;
  }

  addComment(leadId: number, comment: string) {
    return this.call("crm.timeline.comment.add", {
      fields: { ENTITY_ID: leadId, ENTITY_TYPE: "lead", COMMENT: comment },
    });
  }

  buildLeadFields(input: BitrixLeadInput, imType: "INSTAGRAM" | "OTHER" = "INSTAGRAM") {
    const fields: Record<string, unknown> = {
      TITLE: input.title.slice(0, 255),
      SOURCE_ID: this.config.sourceId || "OTHER",
      SOURCE_DESCRIPTION: input.sourceDescription,
      OPENED: "Y",
    };
    if (input.name) fields.NAME = input.name;
    if (input.phoneE164) fields.PHONE = [{ VALUE: input.phoneE164, VALUE_TYPE: "WORK" }];
    if (input.igUsername) fields.IM = [{ VALUE: input.igUsername, VALUE_TYPE: imType }];
    if (this.config.assignedById) fields.ASSIGNED_BY_ID = this.config.assignedById;
    if (input.comments) fields.COMMENTS = input.comments;
    return { fields, params: { REGISTER_SONET_EVENT: "Y" } };
  }

  private async addLead(input: BitrixLeadInput): Promise<number> {
    try {
      return await this.call<number>("crm.lead.add", this.buildLeadFields(input, "INSTAGRAM"));
    } catch (error) {
      // Some portals reject the INSTAGRAM messenger type: retry with OTHER.
      if (
        error instanceof IntegrationRequestError &&
        input.igUsername &&
        /IM|VALUE_TYPE/i.test(error.message)
      ) {
        return this.call<number>("crm.lead.add", this.buildLeadFields(input, "OTHER"));
      }
      throw error;
    }
  }

  async deliverLead(input: BitrixLeadInput, transcript: string): Promise<BitrixDeliveryResult> {
    if (input.phoneE164) {
      const existing = await this.findOpenLeadByPhone(input.phoneE164);
      if (existing) {
        await this.addComment(existing, transcript);
        return {
          leadId: existing,
          url: bitrixLeadUrl(this.base, existing),
          mode: "comment_on_existing",
        };
      }
    }
    const leadId = await this.addLead(input);
    await this.addComment(leadId, transcript);
    return { leadId, url: bitrixLeadUrl(this.base, leadId), mode: "created" };
  }
}
