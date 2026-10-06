/**
 * amoCRM / Kommo client (private integration, long-lived token).
 *
 * Auth is behind `AmoAuthStrategy` so OAuth 2.0 (24h access + 3 month refresh)
 * can be added later without touching the delivery code.
 */

import { IntegrationAuthError, IntegrationRequestError } from "./errors";
import { acquireSlot } from "./throttle";
import { phoneDigits } from "@/lib/leads/phone";

export interface AmoAuthStrategy {
  authorizationHeader(): Promise<string>;
}

export class LongLivedTokenStrategy implements AmoAuthStrategy {
  constructor(private token: string) {}
  async authorizationHeader() {
    return `Bearer ${this.token}`;
  }
}

export type AmoZone = "amocrm.ru" | "kommo.com" | "amocrm.com";

export interface AmoConfig {
  subdomain: string;
  zone: AmoZone;
  pipelineId?: number;
  statusId?: number;
  responsibleUserId?: number;
  campaignTag?: boolean;
  igUsernameFieldId?: number;
  leadNameTemplate?: string;
}

export interface AmoLeadInput {
  name: string;
  phoneE164: string | null;
  contactName: string | null;
  igUsername: string | null;
  campaignName: string | null;
}

export interface AmoDeliveryResult {
  leadId: number;
  url: string;
  mode: "created" | "note_on_existing";
}

const CLOSED_STATUS_IDS = new Set([142, 143]); // successful / lost
const RATE_PER_SECOND = 5;

export function amoLeadUrl(config: Pick<AmoConfig, "subdomain" | "zone">, leadId: number) {
  return `https://${config.subdomain}.${config.zone}/leads/detail/${leadId}`;
}

export function renderLeadName(
  template: string | undefined,
  vars: { name: string | null; product_interest: string | null; username: string | null }
): string {
  const tpl = template?.trim() || "Instagram: {name} — {product_interest}";
  const rendered = tpl
    .replace(/\{name\}/g, vars.name ?? "mijoz")
    .replace(/\{product_interest\}/g, vars.product_interest ?? "")
    .replace(/\{username\}/g, vars.username ?? "")
    .replace(/\s*[—-]\s*$/, "")
    .trim();
  return rendered.slice(0, 255);
}

export class AmoClient {
  constructor(
    private config: AmoConfig,
    private auth: AmoAuthStrategy,
    private throttleKey: string
  ) {}

  private get base() {
    return `https://${this.config.subdomain}.${this.config.zone}`;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    attempt = 0
  ): Promise<T | null> {
    await acquireSlot(`amo:${this.throttleKey}`, RATE_PER_SECOND);
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: await this.auth.authorizationHeader(),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) return null;
    if (response.status === 401 || response.status === 403) {
      throw new IntegrationAuthError("amocrm", `amoCRM responded ${response.status}`);
    }
    if (response.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new IntegrationRequestError(
        "amocrm",
        response.status,
        `amoCRM ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`
      );
    }
    return (await response.json()) as T;
  }

  checkConnection() {
    return this.request<{ id: number; name: string; subdomain: string }>(
      "GET",
      "/api/v4/account"
    );
  }

  async listPipelines() {
    const data = await this.request<{
      _embedded?: {
        pipelines: Array<{
          id: number;
          name: string;
          _embedded?: { statuses: Array<{ id: number; name: string }> };
        }>;
      };
    }>("GET", "/api/v4/leads/pipelines");
    return (data?._embedded?.pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      statuses: (p._embedded?.statuses ?? []).map((s) => ({ id: s.id, name: s.name })),
    }));
  }

  async listUsers() {
    const data = await this.request<{
      _embedded?: { users: Array<{ id: number; name: string }> };
    }>("GET", "/api/v4/users");
    return (data?._embedded?.users ?? []).map((u) => ({ id: u.id, name: u.name }));
  }

  async listContactFields() {
    const data = await this.request<{
      _embedded?: { custom_fields: Array<{ id: number; name: string; type: string }> };
    }>("GET", "/api/v4/contacts/custom_fields");
    return (data?._embedded?.custom_fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
    }));
  }

  /** Existing contact by phone, with the ids of the leads linked to it. */
  async findContactByPhone(
    e164: string
  ): Promise<{ id: number; leadIds: number[] } | null> {
    const data = await this.request<{
      _embedded?: {
        contacts: Array<{ id: number; _embedded?: { leads?: Array<{ id: number }> } }>;
      };
    }>(
      "GET",
      `/api/v4/contacts?query=${encodeURIComponent(phoneDigits(e164))}&with=leads`
    );
    const contact = data?._embedded?.contacts?.[0];
    if (!contact) return null;
    return {
      id: contact.id,
      leadIds: (contact._embedded?.leads ?? []).map((l) => l.id),
    };
  }

  async isLeadOpen(leadId: number): Promise<boolean> {
    const lead = await this.request<{ status_id?: number; closed_at?: number | null }>(
      "GET",
      `/api/v4/leads/${leadId}`
    );
    if (!lead) return false;
    if (lead.status_id !== undefined && CLOSED_STATUS_IDS.has(lead.status_id)) return false;
    return !lead.closed_at;
  }

  addNote(leadId: number, text: string) {
    return this.request("POST", `/api/v4/leads/${leadId}/notes`, [
      { note_type: "common", params: { text } },
    ]);
  }

  buildComplexPayload(
    input: AmoLeadInput,
    existingContactId?: number
  ): Array<Record<string, unknown>> {
    const tags: Array<{ name: string }> = [{ name: "instagram" }, { name: "socialauto" }];
    if (this.config.campaignTag && input.campaignName) {
      tags.push({ name: input.campaignName.slice(0, 255) });
    }

    const contactFields: Array<Record<string, unknown>> = [];
    if (input.phoneE164) {
      contactFields.push({
        field_code: "PHONE",
        values: [{ enum_code: "WORK", value: input.phoneE164 }],
      });
    }
    if (this.config.igUsernameFieldId && input.igUsername) {
      contactFields.push({
        field_id: this.config.igUsernameFieldId,
        values: [{ value: `@${input.igUsername}` }],
      });
    }

    const contact: Record<string, unknown> = existingContactId
      ? { id: existingContactId }
      : {
          first_name: input.contactName ?? input.igUsername ?? "Instagram",
          ...(contactFields.length ? { custom_fields_values: contactFields } : {}),
        };

    const lead: Record<string, unknown> = {
      name: input.name,
      _embedded: { tags, contacts: [contact] },
    };
    if (this.config.pipelineId) lead.pipeline_id = this.config.pipelineId;
    if (this.config.statusId) lead.status_id = this.config.statusId;
    if (this.config.responsibleUserId) lead.responsible_user_id = this.config.responsibleUserId;
    return [lead];
  }

  /**
   * Full delivery flow (TZ 7.2): dedup by phone -> note on an open lead, or a
   * new complex lead (linked to the existing contact when there is one) + note.
   */
  async deliverLead(input: AmoLeadInput, noteText: string): Promise<AmoDeliveryResult> {
    let existingContactId: number | undefined;

    if (input.phoneE164) {
      const contact = await this.findContactByPhone(input.phoneE164);
      if (contact) {
        existingContactId = contact.id;
        for (const leadId of contact.leadIds.slice(0, 5)) {
          if (await this.isLeadOpen(leadId)) {
            await this.addNote(leadId, noteText);
            return {
              leadId,
              url: amoLeadUrl(this.config, leadId),
              mode: "note_on_existing",
            };
          }
        }
      }
    }

    const created = await this.request<Array<{ id: number; merged?: boolean }>>(
      "POST",
      "/api/v4/leads/complex",
      this.buildComplexPayload(input, existingContactId)
    );
    const leadId = created?.[0]?.id;
    if (!leadId) {
      throw new IntegrationRequestError("amocrm", null, "amoCRM returned no lead id");
    }
    if (created?.[0]?.merged) {
      console.log(`[amoCRM] complex lead ${leadId} was merged into an existing one`);
    }
    await this.addNote(leadId, noteText);
    return { leadId, url: amoLeadUrl(this.config, leadId), mode: "created" };
  }
}
