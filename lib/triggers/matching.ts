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
 * "Narxi?? 🔥" and "narxi" compare equal. Story replies keep this V1
 * behaviour; comments (bottom of the file) use the cross-script normaliser
 * and intents from keywords.ts.
 *
 * Pure: no database — the processor loads campaigns and passes them in.
 */

import {
  foldDiacritics,
  normalizeArabicScript,
  stripSpecialCharacters,
} from "@/lib/utils/keyword-matcher";
import { findIntent, findKeyword, isBuiltInIntent } from "./keywords";
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

// ─── COMMENT (Comment Automation 2.0) ─────────────────────────────────────────
//
// Comments use the normaliser in keywords.ts (cross-script, whole words) and
// built-in intents. One comment gets at most one campaign (Meta allows one
// private reply per comment), chosen by TZ 8.2:
//
//   1. how it matched: EXACT keyword > CONTAINS keyword > INTENT > EVERY
//   2. a campaign for this specific post beats an "any post" campaign
//   3. higher `priority`
//   4. the oldest campaign (stable between deliveries)

export type CommentMatchKind = "EXACT" | "CONTAINS" | "INTENT" | "EVERY";
export type MediaScope = "ANY" | "SPECIFIC";

export interface CommentMatchableCampaign {
  id: string;
  /** Optional so pure tests can skip it; anything but COMMENT never matches. */
  triggerType?: NormalizedEventType;
  active: boolean;
  mediaScope: MediaScope;
  mediaIds: string[];
  keywords: string[];
  matchingMode: MatchMode;
  intents: string[];
  priority: number;
  createdAt: Date;
}

export interface CommentInput {
  mediaId: string | null;
  text: string;
  /** A comment on an ad carries the ad's media id; this is the organic post it came from. */
  altMediaId?: string | null;
  /** LIVE_COMMENT matches the LIVE_COMMENT campaigns; default COMMENT. */
  eventType?: "COMMENT" | "LIVE_COMMENT";
}

export type CommentVerdict =
  | { matched: true; kind: CommentMatchKind; matchedKeyword: string | null; intent: string | null }
  | { matched: false; reason: "inactive" | "wrong_trigger" | "media_scope" | "no_condition" | "keyword" };

const KIND_RANK: Record<CommentMatchKind, number> = { EXACT: 3, CONTAINS: 2, INTENT: 1, EVERY: 0 };

export function evaluateCommentCampaign(campaign: CommentMatchableCampaign, input: CommentInput): CommentVerdict {
  const eventType = input.eventType ?? "COMMENT";
  if (!campaign.active) return { matched: false, reason: "inactive" };
  if (campaign.triggerType && campaign.triggerType !== eventType) return { matched: false, reason: "wrong_trigger" };

  // Live campaigns are always "any broadcast": a live video's id is not known
  // in advance, so a stray SPECIFIC scope must not silence the campaign.
  if (campaign.mediaScope === "SPECIFIC" && eventType === "COMMENT") {
    const ids = [input.mediaId, input.altMediaId].filter((id): id is string => Boolean(id));
    if (!ids.some((id) => campaign.mediaIds.includes(id))) return { matched: false, reason: "media_scope" };
  }

  return evaluateTextCondition(campaign, input.text);
}

/**
 * Keywords (EXACT / CONTAINS) → intents → EVERY, on the Comment 2.0
 * normaliser. Shared by comments, live comments and the DM-side triggers.
 */
export function evaluateTextCondition(
  campaign: Pick<CommentMatchableCampaign, "keywords" | "matchingMode" | "intents">,
  text: string
): CommentVerdict {
  const keywords = cleanKeywords(campaign.keywords);
  const intents = campaign.intents.filter(isBuiltInIntent);

  if ((campaign.matchingMode === "EXACT" || campaign.matchingMode === "CONTAINS") && keywords.length > 0) {
    const keyword = findKeyword(text, keywords, campaign.matchingMode);
    if (keyword) return { matched: true, kind: campaign.matchingMode, matchedKeyword: keyword, intent: null };
  }
  if (intents.length > 0) {
    const hit = findIntent(text, intents);
    if (hit) return { matched: true, kind: "INTENT", matchedKeyword: hit.example, intent: hit.intent };
  }
  if (campaign.matchingMode === "EVERY") return { matched: true, kind: "EVERY", matchedKeyword: null, intent: null };

  if (keywords.length === 0 && intents.length === 0) return { matched: false, reason: "no_condition" };
  return { matched: false, reason: "keyword" };
}

export interface CommentSelection<C extends CommentMatchableCampaign> {
  campaign: C | null;
  matchKind: CommentMatchKind | null;
  matchedKeyword: string | null;
  intent: string | null;
  /** Why nothing matched, for the log. Null when a campaign was picked. */
  ignoredReason: string | null;
  considered: number;
}

export function selectCommentCampaign<C extends CommentMatchableCampaign>(
  campaigns: C[],
  input: CommentInput
): CommentSelection<C> {
  const none = (ignoredReason: string, considered: number): CommentSelection<C> => ({
    campaign: null,
    matchKind: null,
    matchedKeyword: null,
    intent: null,
    ignoredReason,
    considered,
  });

  const eventType = input.eventType ?? "COMMENT";
  const candidates = campaigns.filter((c) => c.active && (!c.triggerType || c.triggerType === eventType));
  if (candidates.length === 0) {
    return none(eventType === "LIVE_COMMENT" ? "Jonli efir izohlari uchun faol kampaniya yo'q" : "Izohlar uchun faol kampaniya yo'q", 0);
  }

  const matches: Array<{ campaign: C; kind: CommentMatchKind; matchedKeyword: string | null; intent: string | null }> = [];
  let mediaMisses = 0;
  for (const campaign of candidates) {
    const verdict = evaluateCommentCampaign(campaign, input);
    if (verdict.matched) {
      matches.push({ campaign, kind: verdict.kind, matchedKeyword: verdict.matchedKeyword, intent: verdict.intent });
    } else if (verdict.reason === "media_scope") {
      mediaMisses++;
    }
  }

  if (matches.length === 0) {
    return none(
      mediaMisses === candidates.length ? "Bu post uchun kampaniya sozlanmagan" : "Kalit so'z yoki intent mos kelmadi",
      candidates.length
    );
  }

  matches.sort((a, b) => {
    const kind = KIND_RANK[b.kind] - KIND_RANK[a.kind];
    if (kind !== 0) return kind;
    const scope = Number(b.campaign.mediaScope === "SPECIFIC") - Number(a.campaign.mediaScope === "SPECIFIC");
    if (scope !== 0) return scope;
    const priority = (b.campaign.priority ?? 0) - (a.campaign.priority ?? 0);
    if (priority !== 0) return priority;
    return a.campaign.createdAt.getTime() - b.campaign.createdAt.getTime();
  });

  const best = matches[0];
  return {
    campaign: best.campaign,
    matchKind: best.kind,
    matchedKeyword: best.matchedKeyword,
    intent: best.intent,
    ignoredReason: null,
    considered: candidates.length,
  };
}

/** What the log shows as "matched by": the keyword, or "PRICE: narxi" for an intent. */
export function describeCommentMatch(selection: { matchedKeyword: string | null; intent: string | null }): string | null {
  if (selection.intent) return `${selection.intent}: ${selection.matchedKeyword ?? ""}`.trim();
  return selection.matchedKeyword;
}

// ─── DIRECT_MESSAGE / STORY_MENTION (ETAP 3) ──────────────────────────────────
//
// DM-side triggers use the same text condition as comments, plus who is
// writing (audience), where they came from (source filter) and an anti-spam
// cooldown. One event gets at most one campaign:
//
//   1. how it matched: EXACT keyword > CONTAINS keyword > INTENT > EVERY
//   2. a source-filtered (ad / link) or audience-filtered campaign beats ANY
//      (source counts more than audience)
//   3. higher `priority`
//   4. the oldest campaign
//
// A campaign still in its cooldown for this person is skipped, so the next
// best one may answer.

export type DmTriggerEventType = "DIRECT_MESSAGE" | "STORY_MENTION";
export type DmAudience = "ANY" | "NEW_CONTACT" | "RETURNING_CONTACT" | "REOPENED";
export type DmSourceFilter = "ANY" | "ADS" | "LINK";

export interface DmMatchableCampaign {
  id: string;
  triggerType?: NormalizedEventType;
  active: boolean;
  keywords: string[];
  matchingMode: MatchMode;
  intents: string[];
  priority: number;
  createdAt: Date;
  audience?: DmAudience | null;
  reopenAfterHours?: number | null;
  cooldownHours?: number | null;
  sourceFilter?: DmSourceFilter | null;
  adIds?: string[] | null;
  refs?: string[] | null;
}

export interface DmInput {
  type: DmTriggerEventType;
  text: string;
  referralSource?: string | null;
  adId?: string | null;
  ref?: string | null;
  /** True when this event is the person's first interaction with the account. */
  firstInteraction: boolean;
  /** Hours since the person's previous DM-side message; null when there is none. */
  hoursSincePreviousInbound: number | null;
  /** campaignId → when that campaign last answered this person. */
  lastSentAt?: Map<string, Date>;
  /** The event's time (cooldown is measured from it). */
  at: Date;
}

export const DEFAULT_REOPEN_AFTER_HOURS = 72;
export const DEFAULT_COOLDOWN_HOURS = 24;

type DmMiss = "inactive" | "wrong_trigger" | "source" | "audience" | "no_condition" | "keyword" | "cooldown";

export type DmVerdict =
  | { matched: true; kind: CommentMatchKind; matchedKeyword: string | null; intent: string | null }
  | { matched: false; reason: DmMiss };

export function matchesSource(campaign: DmMatchableCampaign, input: Pick<DmInput, "referralSource" | "adId" | "ref">): boolean {
  const filter = campaign.sourceFilter ?? "ANY";
  if (filter === "ADS") {
    if ((input.referralSource ?? "").toUpperCase() !== "ADS") return false;
    const ids = campaign.adIds ?? [];
    return ids.length === 0 || (Boolean(input.adId) && ids.includes(input.adId!));
  }
  if (filter === "LINK") {
    if (!input.ref) return false;
    const refs = campaign.refs ?? [];
    return refs.length === 0 || refs.includes(input.ref);
  }
  return true;
}

export function matchesAudience(
  campaign: DmMatchableCampaign,
  input: Pick<DmInput, "firstInteraction" | "hoursSincePreviousInbound">
): boolean {
  const audience = campaign.audience ?? "ANY";
  if (audience === "NEW_CONTACT") return input.firstInteraction;
  if (audience === "RETURNING_CONTACT") return !input.firstInteraction;
  if (audience === "REOPENED") {
    const after = campaign.reopenAfterHours ?? DEFAULT_REOPEN_AFTER_HOURS;
    return !input.firstInteraction && input.hoursSincePreviousInbound !== null && input.hoursSincePreviousInbound >= after;
  }
  return true;
}

/** True while this campaign may not answer the person again. */
export function inCooldown(campaign: DmMatchableCampaign, lastSentAt: Date | undefined, at: Date): boolean {
  const hours = campaign.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  if (!lastSentAt || hours <= 0) return false;
  return at.getTime() - lastSentAt.getTime() < hours * 3600_000;
}

export function evaluateDmCampaign(campaign: DmMatchableCampaign, input: DmInput): DmVerdict {
  if (!campaign.active) return { matched: false, reason: "inactive" };
  if (campaign.triggerType && campaign.triggerType !== input.type) return { matched: false, reason: "wrong_trigger" };
  if (!matchesSource(campaign, input)) return { matched: false, reason: "source" };
  if (!matchesAudience(campaign, input)) return { matched: false, reason: "audience" };
  const text = evaluateTextCondition(campaign, input.text);
  if (!text.matched) return { matched: false, reason: text.reason === "no_condition" ? "no_condition" : "keyword" };
  if (inCooldown(campaign, input.lastSentAt?.get(campaign.id), input.at)) return { matched: false, reason: "cooldown" };
  return text;
}

function dmSpecificity(campaign: DmMatchableCampaign): number {
  return ((campaign.sourceFilter ?? "ANY") !== "ANY" ? 2 : 0) + ((campaign.audience ?? "ANY") !== "ANY" ? 1 : 0);
}

// How far a campaign got before it missed — the furthest one explains the log line.
const DM_MISS_STAGE: Record<DmMiss, number> = {
  inactive: 0, wrong_trigger: 0, source: 1, audience: 2, no_condition: 3, keyword: 3, cooldown: 4,
};
const DM_MISS_REASON: Record<DmMiss, string> = {
  inactive: "Faol kampaniya yo'q",
  wrong_trigger: "Faol kampaniya yo'q",
  source: "Manba sharti mos kelmadi (reklama / havola)",
  audience: "Auditoriya sharti mos kelmadi (yangi / qaytgan / qayta ochilgan)",
  no_condition: "Kalit so'z yoki intent mos kelmadi",
  keyword: "Kalit so'z yoki intent mos kelmadi",
  cooldown: "Kutish vaqti (cooldown): bu kampaniya bu odamga yaqinda javob bergan",
};

export interface DmSelection<C extends DmMatchableCampaign> {
  campaign: C | null;
  matchKind: CommentMatchKind | null;
  matchedKeyword: string | null;
  intent: string | null;
  ignoredReason: string | null;
  considered: number;
}

export function selectDmCampaign<C extends DmMatchableCampaign>(campaigns: C[], input: DmInput): DmSelection<C> {
  const none = (ignoredReason: string, considered: number): DmSelection<C> => ({
    campaign: null,
    matchKind: null,
    matchedKeyword: null,
    intent: null,
    ignoredReason,
    considered,
  });

  const candidates = campaigns.filter((c) => c.active && (!c.triggerType || c.triggerType === input.type));
  if (candidates.length === 0) {
    return none(input.type === "STORY_MENTION" ? "Story mention uchun faol kampaniya yo'q" : "Direct uchun faol kampaniya yo'q", 0);
  }

  const matches: Array<{ campaign: C; kind: CommentMatchKind; matchedKeyword: string | null; intent: string | null }> = [];
  let furthest: DmMiss = "inactive";
  for (const campaign of candidates) {
    const verdict = evaluateDmCampaign(campaign, input);
    if (verdict.matched) {
      matches.push({ campaign, kind: verdict.kind, matchedKeyword: verdict.matchedKeyword, intent: verdict.intent });
    } else if (DM_MISS_STAGE[verdict.reason] >= DM_MISS_STAGE[furthest]) {
      furthest = verdict.reason;
    }
  }
  if (matches.length === 0) return none(DM_MISS_REASON[furthest], candidates.length);

  matches.sort((a, b) => {
    const kind = KIND_RANK[b.kind] - KIND_RANK[a.kind];
    if (kind !== 0) return kind;
    const specific = dmSpecificity(b.campaign) - dmSpecificity(a.campaign);
    if (specific !== 0) return specific;
    const priority = (b.campaign.priority ?? 0) - (a.campaign.priority ?? 0);
    if (priority !== 0) return priority;
    return a.campaign.createdAt.getTime() - b.campaign.createdAt.getTime();
  });

  const best = matches[0];
  return {
    campaign: best.campaign,
    matchKind: best.kind,
    matchedKeyword: best.matchedKeyword,
    intent: best.intent,
    ignoredReason: null,
    considered: candidates.length,
  };
}
