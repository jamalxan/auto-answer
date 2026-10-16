/**
 * ETAP 6 — the IN-MEMORY effects port (sandbox / test console and the unit
 * tests of the engine). Same `FlowEffects` interface as the real port in
 * effects.ts, none of its side effects: nothing is written to the database,
 * nothing is sent to Instagram, no model is called, no HTTP request leaves.
 * Sends, tags, leads and the rest are only RECORDED; the clock is fake and
 * moves only when the driver moves it, so a run is fully deterministic.
 *
 * Pure: no Prisma import (the sandbox must never be able to touch it).
 */

import type { FlowContext } from "./variables";
import { webhookUrlProblem } from "./policy";
import type {
  Chip,
  EffectResult,
  FlowEffects,
  FlowRunState,
  SendOutcome,
  SendRef,
  StepRecord,
  WebhookResult,
  WindowAnchors,
} from "./runner";

export interface MemoryContact {
  name?: string | null;
  username?: string | null;
  phone?: string | null;
  email?: string | null;
  language?: string | null;
  tags?: string[];
  score?: number | null;
  temperature?: string | null;
  audience?: string | null;
}

export interface MemoryEffectsOptions {
  /** The fake clock's start. */
  start: Date;
  contact?: MemoryContact;
  /** Initial 24h window for a DM-side trigger (comment runs start without one). Default open. */
  windowOpen?: boolean;
  /** Is JavobAI LIVE on the account (takeover works)? Default true. */
  aiLive?: boolean;
  /** Stored as the trigger text / keyword of the run. */
  triggerText?: string;
  /** Force a send failure (tests of the retry path): called per send, return an outcome to override. */
  sendHook?: (kind: "text" | "button" | "chips", ref: SendRef, text: string) => SendOutcome | null;
}

export interface RecordedSend {
  nodeId: string;
  text: string;
  buttons?: Array<{ id: string; label: string; kind?: string }>;
  /** A comment's first message goes out as a private reply. */
  privateReply?: boolean;
  at: string;
}

export interface RecordedStep extends StepRecord {
  seq: number;
  at: string;
}

export class MemoryEffects implements FlowEffects {
  clock: Date;
  anchors: WindowAnchors;
  steps: RecordedStep[] = [];
  sends: RecordedSend[] = [];
  /** Side effects that were only recorded ("would call", "would tag"...). */
  effects: Array<{ kind: string; detail: Record<string, unknown>; at: string }> = [];
  tags: Set<string>;
  failures: string[] = [];
  private readonly contact: MemoryContact;
  private readonly aiLive: boolean;
  private readonly sendHook?: MemoryEffectsOptions["sendHook"];

  constructor(options: MemoryEffectsOptions) {
    this.clock = new Date(options.start);
    this.contact = options.contact ?? {};
    this.aiLive = options.aiLive !== false;
    this.sendHook = options.sendHook;
    this.tags = new Set(this.contact.tags ?? []);
    this.anchors = { openedAt: null, lastInboundAt: null };
  }

  /** Move the fake clock (never backwards). */
  setNow(at: Date) {
    if (at.getTime() > this.clock.getTime()) this.clock = new Date(at);
  }

  private note(kind: string, detail: Record<string, unknown> = {}) {
    this.effects.push({ kind, detail, at: this.clock.toISOString() });
  }

  now() {
    return new Date(this.clock);
  }

  async window() {
    return { ...this.anchors };
  }

  async touchInbound(_run: FlowRunState, at: Date, info: { open: boolean }) {
    if (!this.anchors.lastInboundAt || at.getTime() > this.anchors.lastInboundAt.getTime()) this.anchors.lastInboundAt = at;
    if (info.open && !this.anchors.openedAt) this.anchors.openedAt = at;
  }

  async context(): Promise<FlowContext> {
    const c = this.contact;
    return {
      contact: { name: c.name ?? null, username: c.username ?? null, phone: c.phone ?? null, email: c.email ?? null, language: c.language ?? null },
      tags: [...this.tags],
      score: c.score ?? 0,
      temperature: c.temperature ?? "COLD",
      audience: c.audience ?? null,
    };
  }

  async commit(prev: FlowRunState, _next: FlowRunState, step: StepRecord) {
    this.steps.push({ ...step, seq: prev.seq + 1, at: this.clock.toISOString() });
    return true;
  }

  async publicReply(_run: FlowRunState, text: string) {
    this.note("public_reply", { text });
  }

  private async send(kind: "text" | "button" | "chips", ref: SendRef, text: string, buttons?: RecordedSend["buttons"]): Promise<SendOutcome> {
    const forced = this.sendHook?.(kind, ref, text);
    if (forced) return forced;
    this.sends.push({ nodeId: ref.nodeId, text, ...(buttons ? { buttons } : {}), ...(ref.first ? { privateReply: true } : {}), at: this.clock.toISOString() });
    return { ok: true, mid: `sandbox.${this.sends.length}` };
  }

  sendText(_run: FlowRunState, ref: SendRef, text: string) {
    return this.send("text", ref, text);
  }

  sendButton(_run: FlowRunState, ref: SendRef, text: string, button: { id: string; label: string }) {
    return this.send("button", ref, text, [button]);
  }

  sendChips(_run: FlowRunState, ref: SendRef, text: string, chips: Chip[]) {
    return this.send("chips", ref, text, chips);
  }

  async tag(_run: FlowRunState, action: "add" | "remove", slugs: string[]): Promise<EffectResult> {
    for (const slug of slugs) {
      if (action === "add") this.tags.add(slug);
      else this.tags.delete(slug);
    }
    this.note(`tag_${action}`, { slugs });
    return { ok: true };
  }

  async lead(_run: FlowRunState, input: { phoneE164: string; summary: string | null }): Promise<EffectResult> {
    this.note("lead", { phone: input.phoneE164, summary: input.summary });
    return { ok: true };
  }

  async crm(_run: FlowRunState, node: { action: string }): Promise<EffectResult> {
    this.note("crm", { action: node.action });
    return { ok: true };
  }

  async operator(_run: FlowRunState, input: { note: string | null; reason: string }): Promise<EffectResult> {
    this.note("operator", { ...input });
    return { ok: true };
  }

  async notify(_run: FlowRunState, text: string): Promise<EffectResult> {
    this.note("notify_telegram", { text });
    return { ok: true };
  }

  /** Never calls out. A URL that fails the static policy fails like the real node would; anything else is a stub. */
  async webhook(_run: FlowRunState, node: { url: string; saveAs?: string; savePath?: string }, body: Record<string, unknown>): Promise<WebhookResult> {
    const problem = webhookUrlProblem(node.url);
    if (problem) {
      this.note("webhook_refused", { url: node.url, problem });
      return { ok: false, error: `Webhook manzili rad etildi (${problem})` };
    }
    this.note("webhook_stub", { url: node.url, body });
    let json: unknown = {};
    if (node.saveAs && node.savePath) {
      const parts = node.savePath.split(".").filter(Boolean);
      json = parts.reduceRight<unknown>((inner, key) => ({ [key]: inner }), "(test)");
    }
    return { ok: true, status: 200, json };
  }

  async aiTakeover(_run: FlowRunState, _node: unknown, text: string | null) {
    if (!this.aiLive) return { ok: false as const, reason: "not_live" };
    this.note("ai_takeover", { intro: text });
    return { ok: true as const };
  }

  /** No model in the sandbox: the typed answer is the value. */
  async aiExtract(_run: FlowRunState, _node: unknown, text: string) {
    return text.trim().slice(0, 100) || null;
  }

  async optOut(): Promise<EffectResult> {
    this.note("opt_out");
    return { ok: true };
  }

  async stopFollowups(): Promise<EffectResult> {
    this.note("stop_followups");
    return { ok: true };
  }

  async reportFailure(_run: FlowRunState, reason: string) {
    this.failures.push(reason);
  }
}

export function createMemoryEffects(options: MemoryEffectsOptions): MemoryEffects {
  return new MemoryEffects(options);
}
