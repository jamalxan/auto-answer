/**
 * Types and helpers of the ETAP 3 DM-trigger screens (Direct, ad message,
 * ig.me link, Story Mention). Client-safe: no server imports.
 *
 * People pick one of four kinds; the server stores two trigger types, and an
 * ad message / link is a Direct campaign with a source filter.
 */

import type { Audience, MatchingMode, ReplyMode, SourceFilter } from "@/lib/triggers/comment-limits";
import type { SavedFollowUpStep, SavedQuickReply, SavedVariant } from "@/components/developer/comments/shared";

export type DmKind = "DIRECT" | "AD_MESSAGE" | "LINK" | "STORY_MENTION";

export const DM_KINDS: DmKind[] = ["DIRECT", "AD_MESSAGE", "LINK", "STORY_MENTION"];

export const DM_API = "/api/developer/triggers/dm";

export function kindToTrigger(kind: DmKind): {
  triggerType: "DIRECT_MESSAGE" | "STORY_MENTION";
  sourceFilter: SourceFilter;
} {
  if (kind === "STORY_MENTION") return { triggerType: "STORY_MENTION", sourceFilter: "ANY" };
  if (kind === "AD_MESSAGE") return { triggerType: "DIRECT_MESSAGE", sourceFilter: "ADS" };
  if (kind === "LINK") return { triggerType: "DIRECT_MESSAGE", sourceFilter: "LINK" };
  return { triggerType: "DIRECT_MESSAGE", sourceFilter: "ANY" };
}

export function triggerToKind(triggerType: string, sourceFilter: string): DmKind {
  if (triggerType === "STORY_MENTION") return "STORY_MENTION";
  if (sourceFilter === "ADS") return "AD_MESSAGE";
  if (sourceFilter === "LINK") return "LINK";
  return "DIRECT";
}

export function isDmKind(value: string | null | undefined): value is DmKind {
  return Boolean(value && (DM_KINDS as string[]).includes(value));
}

/** What the builder edits: the campaign row plus its child lists. */
export interface DmCampaignView {
  id: string;
  name: string;
  instagramAccountId: string;
  triggerType: "DIRECT_MESSAGE" | "STORY_MENTION";
  matchingMode: MatchingMode;
  keywords: string[];
  intents: string[];
  audience: Audience;
  reopenAfterHours: number;
  cooldownHours: number;
  sourceFilter: SourceFilter;
  adIds: string[];
  refs: string[];
  priority: number;
  replyMode: ReplyMode;
  stopOnReply: boolean;
  stopOnLead: boolean;
  stopOnHandoff: boolean;
  stopOnPurchase: boolean;
  responseMessage: string;
  active: boolean;
  variants: SavedVariant[];
  quickReplies: SavedQuickReply[];
  followUpSteps: SavedFollowUpStep[];
}

export const DM_MATCH_MODE_TEXT: Record<MatchingMode, { title: string; description: string }> = {
  CONTAINS: { title: "Kalit so'z bor", description: "Xabarda so'z uchrasa: “narx” → “narxi qancha?”" },
  EXACT: { title: "Aniq mos", description: "Xabar aynan shu so'zning o'zi bo'lsa" },
  EVERY: { title: "Har bir xabar", description: "Kalit so'zsiz — kelgan har bir xabarga" },
};

/** https://ig.me/m/<username>?ref=<ref> — the link that starts a chat with this ref. */
export function igMeLink(username: string, ref: string): string {
  return `https://ig.me/m/${encodeURIComponent(username)}?ref=${encodeURIComponent(ref)}`;
}
