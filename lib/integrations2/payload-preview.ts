/**
 * ETAP 8.3 — payload preview for the developer UI: build a v1 payload from
 * in-memory inputs and validate it against the schema, so the Events tab
 * shows exactly what a receiver will get (and the schema and the assembler
 * cannot drift apart unnoticed).
 */

import { buildPayload, outboundPayloadV1Schema, sampleEvent, type BuildPayloadInput, type OutboundPayloadV1 } from "./events";
import type { OutboundEventType } from "./config";

export type PayloadPreview =
  | { ok: true; payload: OutboundPayloadV1; json: string }
  | { ok: false; issues: string[] };

export function previewPayload(input: BuildPayloadInput): PayloadPreview {
  const parsed = outboundPayloadV1Schema.safeParse(buildPayload(input));
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  return { ok: true, payload: parsed.data, json: JSON.stringify(parsed.data, null, 2) };
}

/** The documented example of an event type, validated (used by the Docs tab). */
export function previewSample(type: OutboundEventType, baseUrl?: string): PayloadPreview {
  const parsed = outboundPayloadV1Schema.safeParse(sampleEvent(type, baseUrl));
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  return { ok: true, payload: parsed.data, json: JSON.stringify(parsed.data, null, 2) };
}
