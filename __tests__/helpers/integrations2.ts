/**
 * Shared fixtures of the ETAP 8 (Integrations 2.0) tests: seeding the
 * workspace / lead / integration rows in the memory db, a frozen payload, a
 * fake `fetch` that records its calls, an in-memory Redis, and a real RSA key
 * for the Google service account.
 */

import { generateKeyPairSync } from "node:crypto";
import { encryptCredentials } from "../../lib/integrations/crypto";
import { sampleEvent, type OutboundPayloadV1 } from "../../lib/integrations2/events";
import type { OutboundEventType } from "../../lib/integrations2/config";
import { db } from "./db-instance";

export const SECRET = "whsec_" + "a".repeat(43);
export const HOOK_URL = "https://hooks.example.com/socialauto";
export const PUBLIC_RESOLVER = async () => ["93.184.216.34"];

let rsa: string | null = null;
/** A real PKCS#8 private key (generated once per test file). */
export function privateKeyPem(): string {
  if (!rsa) {
    rsa = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  }
  return rsa;
}

export function serviceAccountJson(email = "bot@proj.iam.gserviceaccount.com"): string {
  return JSON.stringify({ type: "service_account", project_id: "proj", client_email: email, private_key: privateKeyPem() });
}

export const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

export function seedWorkspace(id = "w1") {
  db.seed("workspace", { id, name: "Demo markaz" });
  db.seed("instagramAccount", { id: `${id}_a1`, workspaceId: id, username: "demo.markaz", instagramId: `${id}_ig1` });
  return { workspaceId: id, accountId: `${id}_a1` };
}

export function seedLead(opts: { id?: string; workspaceId?: string; accountId?: string; temperature?: "COLD" | "WARM" | "HOT"; score?: number; isTest?: boolean } = {}) {
  const workspaceId = opts.workspaceId ?? "w1";
  const id = opts.id ?? "l1";
  const lead = db.seed("lead", {
    id,
    workspaceId,
    instagramAccountId: opts.accountId ?? `${workspaceId}_a1`,
    conversationId: null,
    idempotencyKey: `key_${id}`,
    igUserId: `u_${id}`,
    igUsername: "aziz_ig",
    name: "Aziz",
    phoneE164: "+998901234567",
    productInterest: "IELTS",
    summary: "Narxni so'radi",
    isTest: opts.isTest ?? false,
  });
  if (opts.temperature) {
    db.seed("aiLeadInsight", {
      leadId: id,
      score: opts.score ?? (opts.temperature === "HOT" ? 72 : opts.temperature === "WARM" ? 40 : 10),
      temperature: opts.temperature,
      signals: [{ signal: "phone_provided", points: 30 }],
    });
  }
  return lead;
}

export function seedWebhook(opts: { id?: string; workspaceId?: string; type?: "WEBHOOK" | "MAKE" | "ZAPIER"; rate?: number; url?: string; secret?: string; status?: string } = {}) {
  return db.seed("integration", {
    id: opts.id ?? "int_hook",
    workspaceId: opts.workspaceId ?? "w1",
    type: opts.type ?? "WEBHOOK",
    name: "Webhook",
    status: opts.status ?? "ACTIVE",
    credentialsEncrypted: encryptCredentials({ secret: opts.secret ?? SECRET }),
    config: { url: opts.url ?? HOOK_URL, preset: opts.type ?? "WEBHOOK", rateLimitPerMinute: opts.rate ?? 60 },
  });
}

export function seedSheets(opts: { id?: string; workspaceId?: string } = {}) {
  return db.seed("integration", {
    id: opts.id ?? "int_sheet",
    workspaceId: opts.workspaceId ?? "w1",
    type: "GOOGLE_SHEETS",
    name: "Jadval",
    credentialsEncrypted: encryptCredentials({ client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKeyPem() }),
    config: { spreadsheetId: SPREADSHEET_ID, sheetName: "SocialAuto" },
  });
}

export function seedSubscription(integrationId: string, eventType: OutboundEventType = "lead.created", filter: Record<string, unknown> = { v: 1 }, active = true) {
  return db.seed("integrationSubscription", { integrationId, eventType, filter, active });
}

/** An event with a frozen payload and one PENDING delivery that is due now. */
export function seedDelivery(opts: {
  integrationId: string;
  subscriptionId?: string | null;
  type?: OutboundEventType;
  payload?: OutboundPayloadV1;
  workspaceId?: string;
  attempts?: number;
  status?: string;
  nextAttemptAt?: Date | null;
}) {
  const type = opts.type ?? "lead.created";
  const eventId = `evt_${Math.random().toString(36).slice(2, 10)}`;
  const payload = { ...(opts.payload ?? sampleEvent(type)), id: eventId, type };
  db.seed("outboundEvent", {
    id: eventId,
    workspaceId: opts.workspaceId ?? "w1",
    type,
    subjectType: "lead",
    subjectId: "l1",
    isTest: payload.is_test,
    payload,
    materializedAt: new Date(),
    dedupeKey: `${type}:${eventId}`,
    occurredAt: new Date(),
  });
  return db.seed("outboundDelivery", {
    eventId,
    integrationId: opts.integrationId,
    subscriptionId: opts.subscriptionId ?? null,
    status: opts.status ?? "PENDING",
    attempts: opts.attempts ?? 0,
    nextAttemptAt: opts.nextAttemptAt === undefined ? new Date(Date.now() - 1000) : opts.nextAttemptAt,
  });
}

// ─── Fake fetch ───────────────────────────────────────────────────────────────

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A `fetch` that answers with `handler` and records every call. */
export function fakeFetch(handler: (call: FetchCall) => FakeReply | Promise<FakeReply>) {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = { url: String(url), method: String(init.method ?? "GET"), headers, body: typeof init.body === "string" ? init.body : "" };
    calls.push(call);
    const reply = await handler(call);
    const status = reply.status ?? 200;
    const text = typeof reply.body === "string" ? reply.body : reply.body === undefined ? "" : JSON.stringify(reply.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(reply.headers ?? {}),
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : null),
    } as unknown as Response;
  };
  return { impl, calls };
}

// ─── Fake Redis ───────────────────────────────────────────────────────────────

export class FakeRedis {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes("NX") && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }
  async incr(key: string) {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  }
  async expire() {
    return 1;
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}
