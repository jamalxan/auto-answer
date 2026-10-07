/**
 * amoCRM / Kommo client (private integration, long-lived token).
 *
 * Auth is behind `AmoAuthStrategy` so OAuth 2.0 (24h access + 3 month refresh)
 * can be added later without touching the delivery code.
 */

import { IntegrationAuthError, IntegrationRequestError } from "./errors";
import { acquireSlot } from "./throttle";

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
  mode: "created";
}

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

  addNote(leadId: number, text: string) {
    return this.request("POST", `/api/v4/leads/${leadId}/notes`, [
      { note_type: "common", params: { text } },
    ]);
  }

  /** A "contact the customer" task on a lead, due at `completeTill`. */
  addTask(leadId: number, text: string, completeTill: Date) {
    const task: Record<string, unknown> = {
      task_type_id: 1, // "Связаться" (call/contact), built into every account
      text,
      complete_till: Math.floor(completeTill.getTime() / 1000),
      entity_id: leadId,
      entity_type: "leads",
    };
    if (this.config.responsibleUserId) task.responsible_user_id = this.config.responsibleUserId;
    return this.request("POST", "/api/v4/tasks", [task]);
  }

  buildComplexPayload(input: AmoLeadInput): Array<Record<string, unknown>> {
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

    const contact: Record<string, unknown> = {
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
   * Full delivery flow: every SocialAuto lead becomes a new amoCRM contact
   * (name + phone) and a new lead linked to it, with the details as a note.
   * There is deliberately no phone dedup — the business wants each request
   * as its own lead in the pipeline, not a note on an older one.
   */
  async deliverLead(input: AmoLeadInput, noteText: string): Promise<AmoDeliveryResult> {
    const created = await this.request<Array<{ id: number; merged?: boolean }>>(
      "POST",
      "/api/v4/leads/complex",
      this.buildComplexPayload(input)
    );
    const leadId = created?.[0]?.id;
    if (!leadId) {
      throw new IntegrationRequestError("amocrm", null, "amoCRM returned no lead id");
    }
    if (created?.[0]?.merged) {
      // amoCRM's own duplicate control ("Контроль дублей") is on for this
      // account and folded the new contact into an existing one.
      console.log(`[amoCRM] complex lead ${leadId} was merged into an existing one`);
    }
    await this.addNote(leadId, noteText);
    return { leadId, url: amoLeadUrl(this.config, leadId), mode: "created" };
  }
}
