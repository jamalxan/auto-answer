/**
 * ETAP 8.1 — the TZ 41.1 HOT lead card for the Telegram HOT subscription.
 * Separate from lib/telegram/lead-message.ts on purpose: the production lead
 * card stays byte-identical; this card is sent only by a subscription on the
 * Telegram integration with a temperature filter.
 */

import type { OutboundPayloadV1 } from "../events";
import { matchesSubscription, type SubscriptionFilter } from "../subscriptions";

/** Telegram HTML parse mode escapes exactly these three (same as lib/telegram/api esc). */
export function esc(value: string | null | undefined): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BAND_LABELS: Record<string, string> = {
  cold: "sovuq",
  warm: "iliq",
  hot: "hot",
  very_hot: "very hot",
};

function sourceLine(payload: OutboundPayloadV1): string {
  const source = payload.source;
  if (!source) return "Noma'lum";
  if (source.campaign) {
    return `Kampaniya "${esc(source.campaign)}"${source.keyword ? ` (${esc(source.keyword)})` : ""}`;
  }
  switch (source.channel) {
    case "comment":
      return "Instagram izoh";
    case "story":
      return "Instagram story";
    case "ad":
      return `Reklama${source.ad_id ? ` #${esc(source.ad_id)}` : ""}`;
    case "broadcast":
      return "Broadcast";
    case "link":
      return `Havola${source.ref ? ` (${esc(source.ref)})` : ""}`;
    default:
      return "Instagram DM";
  }
}

/** 🔥 HOT LEAD / Ism / Telefon / Mahsulot / Score / Manba (TZ 41.1), Telegram HTML. */
export function buildHotLeadText(payload: OutboundPayloadV1): string {
  const lead = payload.lead;
  const score = payload.score;
  const veryHot = score?.band === "very_hot";
  const lines = [
    `${veryHot ? "🔥🔥" : "🔥"} ${payload.is_test ? "[TEST] " : ""}<b>HOT LEAD</b>${payload.account ? ` — @${esc(payload.account.username)}` : ""}`,
    `👤 Ism: ${esc(lead?.name ?? "—")}${lead?.ig_username ? ` (@${esc(lead.ig_username)})` : ""}`,
    lead?.phone ? `📞 Telefon: ${esc(lead.phone)}` : "📞 Telefon: berilmadi",
    `🛋 Mahsulot: ${esc(lead?.product ?? "—")}`,
    score ? `📊 Score: <b>${score.value}</b> (${BAND_LABELS[score.band] ?? score.band})` : "📊 Score: —",
    `📍 Manba: ${sourceLine(payload)}`,
  ];
  if (payload.extra?.budget) lines.push(`💰 Byudjet: ${esc(payload.extra.budget)}`);
  if (payload.extra?.location) lines.push(`🗺 Joylashuv: ${esc(payload.extra.location)}`);
  if (lead?.summary) lines.push(`📝 ${esc(lead.summary)}`);
  if (lead?.conversation_url) lines.push(`💬 <a href="${esc(lead.conversation_url)}">Instagram suhbat</a>`);
  return lines.join("\n");
}

/** The card goes out for HOT payloads that pass the subscription filter. */
export function shouldSendHotCard(filter: SubscriptionFilter, payload: OutboundPayloadV1): boolean {
  if (payload.score?.temperature !== "HOT") return false;
  return matchesSubscription(filter, payload);
}
