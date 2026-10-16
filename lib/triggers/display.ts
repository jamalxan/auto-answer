/**
 * How an event reads in the admin log: one status per row, derived from the
 * event status and the action taken for it. Shared by the UI and its tests.
 */

export type DisplayTone = "success" | "warning" | "error" | "muted";

export interface DisplayStatus {
  key: "SENT" | "SKIPPED" | "IGNORED" | "RETRYING" | "FAILED" | "PROCESSING" | "DONE";
  label: string;
  tone: DisplayTone;
}

interface StatusInput {
  processingStatus: string;
  executions: Array<{ status: string }>;
}

export function displayStatus(event: StatusInput): DisplayStatus {
  const execution = event.executions[event.executions.length - 1];
  switch (event.processingStatus) {
    case "PENDING":
    case "PROCESSING":
      return { key: "PROCESSING", label: "Jarayonda", tone: "warning" };
    case "RETRYING":
      return { key: "RETRYING", label: "Qayta yuboriladi", tone: "warning" };
    case "FAILED":
      return { key: "FAILED", label: "Yuborilmadi", tone: "error" };
    case "IGNORED":
      return { key: "IGNORED", label: "E'tiborsiz", tone: "muted" };
    default:
      if (execution?.status === "SENT") return { key: "SENT", label: "Yuborildi", tone: "success" };
      if (execution?.status === "SKIPPED") return { key: "SKIPPED", label: "O'tkazildi", tone: "muted" };
      return { key: "DONE", label: "Qayta ishlandi", tone: "muted" };
  }
}

export const EVENT_TYPE_LABELS: Record<string, string> = {
  STORY_REPLY: "Story reply",
  STORY_MENTION: "Story mention",
  DIRECT_MESSAGE: "Direct",
  LIVE_COMMENT: "Live komment",
  STORY_REACTION: "Story reaction",
  COMMENT: "Komment",
  MESSAGE_REACTION: "Reaksiya (kuzatuv)",
  ECHO: "Echo (o'zimiz yuborgan)",
  POSTBACK: "Postback (tugma)",
  OTHER: "Boshqa webhook",
};

/** Log filters: every event type, plus Direct messages split by where they came from. */
export const EVENT_FILTER_LABELS: Record<string, string> = {
  STORY_REPLY: "Story reply",
  STORY_MENTION: "Story mention",
  DIRECT_MESSAGE: "Direct (barchasi)",
  REFERRAL_ADS: "Direct · reklamadan",
  REFERRAL_LINK: "Direct · ig.me havoladan",
  LIVE_COMMENT: "Live komment",
  COMMENT: "Komment",
  MESSAGE_REACTION: "Reaksiya (kuzatuv rejimi)",
  ECHO: "Echo",
  POSTBACK: "Postback",
  OTHER: "Boshqa webhook",
};

/** ETAP 3 automation kinds as the home list and the builder name them. */
export const AUTOMATION_KIND_LABELS: Record<string, { title: string; description: string }> = {
  DIRECT: { title: "Direct", description: "Direct'ga xabar yozilganda (kalit so'z, intent yoki har bir xabar)" },
  AD_MESSAGE: { title: "Reklama xabari", description: "Click-to-Direct reklamani bosib yozganlarga" },
  LINK: { title: "ig.me havola", description: "ig.me/akkaunt?ref=… havolasi orqali kelganlarga" },
  STORY_MENTION: { title: "Story mention", description: "Kimdir story'sida akkauntni belgilaganda" },
  STORY_REPLY: { title: "Story reply", description: "Story'ga javob yozilganda (V1)" },
  LIVE_COMMENT: { title: "Live komment", description: "Jonli efirdagi kommentga, efir davomida" },
};

export const AUDIENCE_LABELS: Record<string, { title: string; description: string }> = {
  ANY: { title: "Hamma", description: "Kim yozsa ham" },
  NEW_CONTACT: { title: "Yangi odam", description: "Bu akkauntga birinchi marta yozayotganlar" },
  RETURNING_CONTACT: { title: "Qaytgan odam", description: "Avval ham yozganlar" },
  REOPENED: { title: "Suhbat qayta ochildi", description: "Oxirgi xabaridan beri ko'p vaqt o'tganlar" },
};

/** "Reklama: 1203… · Havola: promo" — where a Direct message came from, or null. */
export function referralLabel(event: {
  referralSource?: string | null;
  adId?: string | null;
  ref?: string | null;
}): string | null {
  if (event.adId || event.referralSource === "ADS") return `Reklama${event.adId ? `: ${event.adId}` : ""}`;
  if (event.ref) return `Havola: ${event.ref}`;
  return null;
}

/** react / unreact from a stored message_reactions payload, wherever Meta put it. */
export function reactionAction(rawPayload: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const reaction = record.reaction;
    if (reaction && typeof reaction === "object" && typeof (reaction as Record<string, unknown>).action === "string") {
      return (reaction as Record<string, unknown>).action as string;
    }
    for (const child of Object.values(record)) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(rawPayload, 0);
}

export const MATCH_MODE_LABELS: Record<string, string> = {
  EVERY: "Har bir reply",
  CONTAINS: "Kalit so'z bor (contains)",
  EXACT: "Aniq mos (exact)",
};

/** "Story #…last6" — story ids are long numbers; the tail is what tells them apart. */
export function shortStoryId(storyId: string | null | undefined): string {
  if (!storyId) return "—";
  return `#${storyId.slice(-6)}`;
}
