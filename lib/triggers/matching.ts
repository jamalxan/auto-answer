/**
 * Trigger matching: which campaign (if any) answers an event.
 *
 * V1 conditions, always case-insensitive:
 *   EVERY    — every event of the trigger type
 *   CONTAINS — the text contains a keyword ("narx" catches "narxi qancha?")
 *   EXACT    — the whole text is a keyword ("narx" only catches "Narx!")
 *
 * Text goes through the same cleanup as comment keywords (emoji/punctuation
 * stripped, Latin diacritics folded, Arabic-script variants unified), so
 * "Narxi?? 🔥" and "narxi" compare equal. Cross-script folding (нарх ↔ narx)
 * is a V2 item.
 *
 * Pure: no database — the processor loads campaigns and passes them in.
 */

import {
  foldDiacritics,
  normalizeArabicScript,
  stripSpecialCharacters,
} from "@/lib/utils/keyword-matcher";
import type { NormalizedEventType } from "./normalize";

export type MatchMode = "EVERY" | "CONTAINS" | "EXACT";
export type StoryScope = "ALL" | "SPECIFIC";

export interface MatchableCampaign {
  id: string;
  triggerType: NormalizedEventType;
  storyScope: StoryScope;
  storyIds: string[];
  keywords: string[];
  matchingMode: MatchMode;
  active: boolean;
  createdAt: Date;
}

export interface MatchableEvent {
  type: NormalizedEventType;
  text: string;
  storyId?: string | null;
}

export type CampaignVerdict =
  | { matched: true; matchedKeyword: string | null }
  | { matched: false; reason: "inactive" | "wrong_trigger" | "story_scope" | "no_keywords" | "keyword" };

export function normalizeMatchText(text: string): string {
  return foldDiacritics(stripSpecialCharacters(normalizeArabicScript(text ?? "")))
    .toLowerCase()
    .trim();
}

/** Keywords as typed in the builder → trimmed, de-duplicated, non-empty. */
export function cleanKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of raw) {
    const trimmed = keyword.trim();
    const key = normalizeMatchText(trimmed);
    if (!trimmed || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function matchText(
  text: string,
  keywords: string[],
  mode: MatchMode
): { matched: boolean; matchedKeyword: string | null } {
  if (mode === "EVERY") return { matched: true, matchedKeyword: null };
  const cleanedText = normalizeMatchText(text);
  if (!cleanedText) return { matched: false, matchedKeyword: null };

  for (const keyword of keywords) {
    const cleanedKeyword = normalizeMatchText(keyword);
    if (!cleanedKeyword) continue;
    const hit = mode === "EXACT" ? cleanedText === cleanedKeyword : cleanedText.includes(cleanedKeyword);
    if (hit) return { matched: true, matchedKeyword: keyword };
  }
  return { matched: false, matchedKeyword: null };
}

export function evaluateCampaign(campaign: MatchableCampaign, event: MatchableEvent): CampaignVerdict {
  if (!campaign.active) return { matched: false, reason: "inactive" };
  if (campaign.triggerType !== event.type) return { matched: false, reason: "wrong_trigger" };

  const storyScoped = event.type === "STORY_REPLY" || event.type === "STORY_MENTION";
  if (storyScoped && campaign.storyScope === "SPECIFIC") {
    if (!event.storyId || !campaign.storyIds.includes(event.storyId)) {
      return { matched: false, reason: "story_scope" };
    }
  }

  if (campaign.matchingMode !== "EVERY" && cleanKeywords(campaign.keywords).length === 0) {
    return { matched: false, reason: "no_keywords" };
  }

  const result = matchText(event.text, campaign.keywords, campaign.matchingMode);
  if (!result.matched) return { matched: false, reason: "keyword" };
  return { matched: true, matchedKeyword: result.matchedKeyword };
}

/**
 * More specific campaigns win: a campaign for this exact story beats one for
 * all stories, and a keyword condition beats "every reply". Ties go to the
 * oldest campaign, so the choice never flips between deliveries.
 */
function specificity(campaign: MatchableCampaign): number {
  let score = 0;
  if (campaign.storyScope === "SPECIFIC") score += 4;
  if (campaign.matchingMode === "EXACT") score += 2;
  else if (campaign.matchingMode === "CONTAINS") score += 1;
  return score;
}

export interface CampaignSelection<C extends MatchableCampaign> {
  campaign: C | null;
  matchedKeyword: string | null;
  /** Why nothing matched, for the log. Null when a campaign was picked. */
  ignoredReason: string | null;
  /** Candidates of this trigger type that were considered. */
  considered: number;
}

/** V1 sends at most one response per event: the best-matching campaign. */
export function selectCampaign<C extends MatchableCampaign>(
  campaigns: C[],
  event: MatchableEvent
): CampaignSelection<C> {
  const candidates = campaigns.filter((c) => c.active && c.triggerType === event.type);
  if (candidates.length === 0) {
    return { campaign: null, matchedKeyword: null, ignoredReason: "Bu trigger uchun faol campaign yo'q", considered: 0 };
  }

  const matches: Array<{ campaign: C; matchedKeyword: string | null }> = [];
  let storyMisses = 0;
  for (const campaign of candidates) {
    const verdict = evaluateCampaign(campaign, event);
    if (verdict.matched) matches.push({ campaign, matchedKeyword: verdict.matchedKeyword });
    else if (verdict.reason === "story_scope") storyMisses++;
  }

  if (matches.length === 0) {
    const reason =
      storyMisses === candidates.length
        ? "Bu story uchun campaign sozlanmagan"
        : "Kalit so'z mos kelmadi";
    return { campaign: null, matchedKeyword: null, ignoredReason: reason, considered: candidates.length };
  }

  matches.sort((a, b) => {
    const diff = specificity(b.campaign) - specificity(a.campaign);
    if (diff !== 0) return diff;
    return a.campaign.createdAt.getTime() - b.campaign.createdAt.getTime();
  });

  return {
    campaign: matches[0].campaign,
    matchedKeyword: matches[0].matchedKeyword,
    ignoredReason: null,
    considered: candidates.length,
  };
}
