export const TRANSCRIPT_MAX_CHARS = 15_000;
const TRUNCATED_NOTICE = "...(oldingi xabarlar qisqartirildi)";

export interface TranscriptMessage {
  author: "CUSTOMER" | "ASSISTANT" | "OPERATOR" | "SYSTEM";
  text: string;
  createdAt: Date;
}

export interface TranscriptLead {
  name?: string | null;
  igUsername?: string | null;
  phoneE164?: string | null;
  productInterest?: string | null;
  campaignName?: string | null;
  triggerKeyword?: string | null;
  postUrl?: string | null;
  source: "CAMPAIGN" | "INBOUND_DM";
  summary?: string | null;
  isTest?: boolean;
}

const AUTHOR_LABEL: Record<TranscriptMessage["author"], string> = {
  CUSTOMER: "Mijoz",
  ASSISTANT: "Assistent",
  OPERATOR: "Operator",
  SYSTEM: "Tizim",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function stamp(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildLeadHeader(lead: TranscriptLead): string {
  const who = [
    lead.name ?? "—",
    lead.igUsername ? `(@${lead.igUsername})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `📥 Instagram lid — SocialAuto${lead.isTest ? " [TEST]" : ""}`,
    `Mijoz: ${who} · ${lead.phoneE164 ?? "raqam berilmadi"}`,
  ];
  if (lead.productInterest) lines.push(`Qiziqish: ${lead.productInterest}`);

  if (lead.source === "CAMPAIGN" && lead.campaignName) {
    const parts = [`Kampaniya "${lead.campaignName}"`];
    if (lead.triggerKeyword) parts.push(`kalit so'z: ${lead.triggerKeyword}`);
    if (lead.postUrl) parts.push(`post: ${lead.postUrl}`);
    lines.push(`Manba: ${parts.join(" · ")}`);
  } else {
    lines.push("Manba: Instagram DM (mijoz o'zi yozdi)");
  }
  if (lead.summary) lines.push(`Xulosa: ${lead.summary}`);
  return lines.join("\n");
}

/**
 * CRM note text (TZ 6.3). Capped at 15 000 chars; when too long the *oldest*
 * messages are dropped and a notice is put in their place.
 */
export function buildTranscript(
  lead: TranscriptLead,
  messages: TranscriptMessage[],
  maxChars: number = TRANSCRIPT_MAX_CHARS
): string {
  const header = buildLeadHeader(lead);
  const lines = messages.map(
    (m) => `[${stamp(m.createdAt)}] ${AUTHOR_LABEL[m.author]}: ${m.text}`
  );

  const prefix = `${header}\n\n--- Suhbat ---\n`;
  const full = prefix + lines.join("\n");
  if (full.length <= maxChars) return full;

  const budget = maxChars - prefix.length - TRUNCATED_NOTICE.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > budget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  return `${prefix}${TRUNCATED_NOTICE}\n${kept.join("\n")}`.slice(0, maxChars);
}
