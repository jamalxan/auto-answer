import { getBaseUrl } from "@/lib/env";
import { esc, type InlineKeyboard } from "./api";

export interface LeadMessageInput {
  id: string;
  igAccountUsername: string;
  name: string | null;
  igUsername: string | null;
  phoneE164: string | null;
  productInterest: string | null;
  extraField: string | null;
  extraFieldLabel?: string | null;
  source: "CAMPAIGN" | "INBOUND_DM";
  campaignName: string | null;
  triggerKeyword: string | null;
  summary: string | null;
  flag: string | null;
  isTest: boolean;
  isRepeat: boolean;
  conversationId: string | null;
  contactedAt: Date | null;
}

export interface CrmLink {
  label: string;
  url: string;
}

export function leadMarker(input: Pick<LeadMessageInput, "flag" | "isRepeat" | "isTest">): string {
  if (input.flag === "complaint") return "🔴";
  if (input.flag === "no_phone") return "🟡";
  if (input.isRepeat) return "🔁";
  return "🟢";
}

export function buildLeadText(input: LeadMessageInput): string {
  const marker = leadMarker(input);
  const title = input.isRepeat
    ? "Takroriy murojaat"
    : input.flag === "complaint"
      ? "Shikoyat / operator kerak"
      : "Yangi lid";
  const lines = [
    `${marker} ${input.isTest ? "[TEST] " : ""}<b>${title}</b> — @${esc(input.igAccountUsername)}`,
    `👤 ${esc(input.name ?? "—")}${input.igUsername ? ` (@${esc(input.igUsername)})` : ""}`,
  ];
  lines.push(
    input.phoneE164
      ? `📞 ${esc(input.phoneE164)}`
      : "📞 Raqam berilmadi — Instagram'da yozing"
  );
  if (input.productInterest) lines.push(`🛋 Qiziqish: ${esc(input.productInterest)}`);
  if (input.extraField) {
    lines.push(`➕ ${esc(input.extraFieldLabel ?? "Qo'shimcha")}: ${esc(input.extraField)}`);
  }
  lines.push(
    input.source === "CAMPAIGN" && input.campaignName
      ? `📍 Manba: Kampaniya "${esc(input.campaignName)}"${
          input.triggerKeyword ? ` (${esc(input.triggerKeyword)})` : ""
        }`
      : "📍 Manba: Instagram DM"
  );
  if (input.summary) lines.push(`📝 ${esc(input.summary)}`);
  if (input.contactedAt) lines.push("✅ Bog'lanildi");
  return lines.join("\n");
}

export function buildLeadKeyboard(
  input: Pick<LeadMessageInput, "id" | "conversationId" | "contactedAt">,
  crmLinks: CrmLink[]
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const first = [];
  if (input.conversationId) {
    first.push({
      text: "💬 Instagram suhbat",
      url: `${getBaseUrl()}/inbox?conversation=${input.conversationId}`,
    });
  }
  for (const link of crmLinks) first.push({ text: `📋 ${link.label}`, url: link.url });
  if (first.length) rows.push(first);
  if (!input.contactedAt) {
    rows.push([{ text: "✅ Bog'lanildi", callback_data: `contacted:${input.id}` }]);
  }
  return rows;
}
