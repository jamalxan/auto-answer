/**
 * Giveaway rules (schema v1) and the pure decision "does this person's entry
 * count?". No database, no network: the collector feeds it facts and stores
 * the verdict.
 *
 * What the platform can really verify is stated in RULE_VERIFIABILITY (shown
 * to the owner verbatim): like / save / share / follow-another-account have no
 * API, tag-friends proves the text only, follow is best effort.
 */

import { z } from "zod";
import { findKeyword, normalizeForMatch } from "@/lib/triggers/keywords";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const giveawayRulesSchema = z.object({
  version: z.literal(1).default(1),
  comment: z
    .object({
      required: z.boolean().default(true),
      /** Comma / newline separated; any of them counts. Ignored with mode ANY. */
      keyword: z.string().trim().max(200).optional(),
      mode: z.enum(["CONTAINS", "EXACT", "ANY"]).default("ANY"),
      minLength: z.number().int().min(0).max(500).default(0),
    })
    .prefault({}),
  tagFriends: z
    .object({
      required: z.boolean().default(false),
      min: z.number().int().min(1).max(10).default(1),
      /** Count different handles only (recommended). */
      distinct: z.boolean().default(true),
    })
    .prefault({}),
  mention: z.object({ required: z.boolean().default(false) }).prefault({}),
  follow: z
    .object({
      required: z.boolean().default(false),
      /** Instagram does not always answer "does X follow us": what to do then. */
      onUnverifiable: z.enum(["ALLOW", "HOLD", "EXCLUDE"]).default("HOLD"),
    })
    .prefault({}),
  /** v1: always one entry per person (database unique key); kept for the record. */
  oneEntryPerPerson: z.boolean().default(true),
  excludeUsernames: z.array(z.string().trim().min(1).max(60)).max(200).default([]),
  /** Skip the business's own account (and listed usernames). */
  excludeStaff: z.boolean().default(true),
});

export type GiveawayRules = z.infer<typeof giveawayRulesSchema>;

export const DEFAULT_RULES: GiveawayRules = giveawayRulesSchema.parse({});

/** Stored rules → a complete rules object; a broken blob falls back to the defaults. */
export function parseRules(value: unknown): GiveawayRules {
  const parsed = giveawayRulesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_RULES;
}

// ─── What can be verified (UI copy, Uzbek) ────────────────────────────────────

export type Verifiability = "yes" | "partly" | "best-effort" | "no";

export interface RuleVerifiability {
  label: string;
  verifiable: Verifiability;
  /** Short badge text. */
  badge: string;
  note: string;
}

export const RULE_VERIFIABILITY: Record<string, RuleVerifiability> = {
  comment: {
    label: "Postga izoh qoldirish",
    verifiable: "yes",
    badge: "Tekshiriladi",
    note: "Izoh webhook orqali olinadi; o'tgan izohlar Graph API orqali yuklanadi.",
  },
  tagFriends: {
    label: "Do'stlarni belgilash",
    verifiable: "partly",
    badge: "Qisman",
    note: "Faqat izohdagi @username matni tekshiriladi — belgilangan odamlar haqiqiyligi tekshirilmaydi.",
  },
  mention: {
    label: "Story'da akkauntni belgilash",
    verifiable: "yes",
    badge: "Tekshiriladi",
    note: "Faqat bizga yetib kelgan story-mention hisobga olinadi (ochiq akkaunt yoki obunachi).",
  },
  follow: {
    label: "Akkauntga obuna bo'lish",
    verifiable: "best-effort",
    badge: "Imkon qadar",
    note: "Instagram har doim ham javob bermaydi; tasdiqlab bo'lmasa qoida bo'yicha qaror qilinadi (qo'lda ko'rib chiqish tavsiya etiladi).",
  },
  like: {
    label: "Postni yoqtirish",
    verifiable: "no",
    badge: "Tekshirib bo'lmaydi",
    note: "Instagram API yoqtirganlarni bermaydi.",
  },
  save: {
    label: "Postni saqlash",
    verifiable: "no",
    badge: "Tekshirib bo'lmaydi",
    note: "Instagram API saqlaganlarni bermaydi.",
  },
  share: {
    label: "Postni ulashish",
    verifiable: "no",
    badge: "Tekshirib bo'lmaydi",
    note: "Instagram API ulashishlarni bermaydi.",
  },
  followOther: {
    label: "Boshqa akkauntga obuna bo'lish",
    verifiable: "no",
    badge: "Tekshirib bo'lmaydi",
    note: "Faqat o'zingizning akkauntingiz uchun obunani tekshirish mumkin.",
  },
};

// ─── Tagged handles ───────────────────────────────────────────────────────────

const HANDLE_PATTERN = /(?<![\w.@])@([a-z0-9._]{1,30})/gi;

function cleanHandle(raw: string): string {
  // "@maria." at the end of a sentence: the dot is punctuation, not part of the name.
  return raw.toLowerCase().replace(/\.+$/, "");
}

export function normalizeHandle(value: string | null | undefined): string {
  return cleanHandle((value ?? "").trim().replace(/^@+/, ""));
}

/**
 * The @handles in a comment, lower-cased, without the business itself.
 * Distinct by default; `keepDuplicates` counts every occurrence.
 */
export function extractTaggedHandles(
  text: string,
  ownUsername?: string | null,
  options: { keepDuplicates?: boolean } = {}
): string[] {
  const own = normalizeHandle(ownUsername);
  const out: string[] = [];
  for (const match of (text ?? "").matchAll(HANDLE_PATTERN)) {
    const handle = cleanHandle(match[1]);
    if (!handle || handle === own) continue;
    if (!options.keepDuplicates && out.includes(handle)) continue;
    out.push(handle);
  }
  return out;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

export type FollowResult = "FOLLOWER" | "NOT_FOLLOWER" | "UNVERIFIABLE" | "NOT_CHECKED";

export interface EntryFacts {
  igUserId: string;
  username?: string | null;
  /** The comment that counts (the first one, or the first that satisfied the comment rule). */
  commentText: string;
  /** Distinct handles accumulated over all of the person's comments. */
  taggedUsernames: string[];
  mentionedAt?: Date | null;
  followResult: FollowResult;
  /** The business's own account: never an entrant. */
  isOwnAccount?: boolean;
}

export interface RuleCheck {
  /** null = not decided yet (follow not checked). */
  passed: boolean | null;
  detail: string;
  at: string;
}

export type EntryVerdict = "ELIGIBLE" | "INELIGIBLE" | "PENDING_CHECK";

export interface EntryEvaluation {
  status: EntryVerdict;
  checks: Record<string, RuleCheck>;
  reason: string | null;
}

function keywordList(keyword: string | undefined): string[] {
  return (keyword ?? "")
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** The comment rule alone (the collector uses it to pick the qualifying comment). */
export function commentPasses(rules: GiveawayRules, text: string): { passed: boolean; detail: string } {
  const rule = rules.comment;
  if (!rule.required) return { passed: true, detail: "Izoh talab qilinmaydi" };
  const normalized = normalizeForMatch(text);
  if (!normalized) return { passed: false, detail: "Izoh matni bo'sh" };
  if (rule.minLength > 0 && normalized.length < rule.minLength) {
    return { passed: false, detail: `Izoh juda qisqa (kamida ${rule.minLength} belgi)` };
  }
  const keywords = keywordList(rule.keyword);
  if (rule.mode === "ANY" || keywords.length === 0) return { passed: true, detail: "Izoh bor" };
  const hit = findKeyword(text, keywords, rule.mode);
  return hit
    ? { passed: true, detail: `Kalit so'z: ${hit}` }
    : { passed: false, detail: `Kalit so'z topilmadi (${keywords.join(", ")})` };
}

/**
 * Decide one entry. Any failed required rule makes it INELIGIBLE (that wins
 * over a pending follow check, so no Graph call is wasted on it); otherwise a
 * follow result that is not in yet — or UNVERIFIABLE under HOLD — leaves it
 * PENDING_CHECK; otherwise ELIGIBLE.
 */
export function evaluateEntry(rules: GiveawayRules, facts: EntryFacts, now: Date): EntryEvaluation {
  const at = now.toISOString();
  const checks: Record<string, RuleCheck> = {};
  const failures: string[] = [];
  let pending: string | null = null;

  const excludedNames = new Set(rules.excludeUsernames.map(normalizeHandle));
  const username = normalizeHandle(facts.username);
  if (facts.isOwnAccount && rules.excludeStaff) {
    checks.excluded = { passed: false, detail: "Akkauntning o'zi", at };
    failures.push("Akkauntning o'zi ishtirok eta olmaydi");
  } else if (username && excludedNames.has(username)) {
    checks.excluded = { passed: false, detail: `@${username} chiqarib tashlangan`, at };
    failures.push("Ishtirokchi ro'yxatdan chiqarilgan");
  }

  if (rules.comment.required) {
    const result = commentPasses(rules, facts.commentText);
    checks.comment = { passed: result.passed, detail: result.detail, at };
    if (!result.passed) failures.push(result.detail);
  }

  if (rules.tagFriends.required) {
    const count = rules.tagFriends.distinct
      ? facts.taggedUsernames.map(normalizeHandle).filter((h) => h && h !== username).length
      : extractTaggedHandles(facts.commentText, null, { keepDuplicates: true }).filter((h) => h !== username).length;
    const passed = count >= rules.tagFriends.min;
    checks.tagFriends = { passed, detail: `${count} ta do'st belgilangan (kamida ${rules.tagFriends.min})`, at };
    if (!passed) failures.push(`Kamida ${rules.tagFriends.min} ta do'st belgilanmagan`);
  }

  if (rules.mention.required) {
    const passed = Boolean(facts.mentionedAt);
    checks.mention = { passed, detail: passed ? "Story'da belgilagan" : "Story-mention hali kelmagan", at };
    if (!passed) failures.push("Story'da akkaunt belgilanmagan");
  }

  if (rules.follow.required) {
    switch (facts.followResult) {
      case "FOLLOWER":
        checks.follow = { passed: true, detail: "Obuna bo'lgan", at };
        break;
      case "NOT_FOLLOWER":
        checks.follow = { passed: false, detail: "Obuna emas", at };
        failures.push("Akkauntga obuna emas");
        break;
      case "UNVERIFIABLE": {
        const policy = rules.follow.onUnverifiable;
        if (policy === "ALLOW") {
          checks.follow = { passed: true, detail: "Tasdiqlab bo'lmadi — ruxsat berildi", at };
        } else if (policy === "EXCLUDE") {
          checks.follow = { passed: false, detail: "Tasdiqlab bo'lmadi — chiqarildi", at };
          failures.push("Obunani tasdiqlab bo'lmadi");
        } else {
          checks.follow = { passed: null, detail: "Tasdiqlab bo'lmadi — qo'lda ko'rib chiqing", at };
          pending = "Obunani tasdiqlab bo'lmadi — qo'lda ko'rib chiqish kerak";
        }
        break;
      }
      default:
        checks.follow = { passed: null, detail: "Obuna hali tekshirilmagan", at };
        pending = "Obuna tekshirilmoqda";
    }
  }

  if (failures.length > 0) return { status: "INELIGIBLE", checks, reason: failures[0] };
  if (pending) return { status: "PENDING_CHECK", checks, reason: pending };
  return { status: "ELIGIBLE", checks, reason: null };
}
