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
  LIVE_COMMENT: "Live comment",
  STORY_REACTION: "Story reaction",
  COMMENT: "Comment",
};

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
