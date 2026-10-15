/**
 * Comment Automation 2.0 — keyword normaliser and built-in intents (TZ 8.1).
 *
 * People write the same word many ways: "Narxi?", "НАРХИ", "нархи", "narhi",
 * "Цена?". Both sides of every comparison go through normalizeForMatch(), so
 * the merchant types a keyword once in any script and catches all of them:
 *
 *   lowercase → Cyrillic (Uzbek + Russian) → Latin → apostrophes removed
 *   (o‘ / o' / oʻ / o` / ў all become "o") → emoji / punctuation stripped →
 *   Latin diacritics folded → whitespace collapsed
 *
 * Matching works on whole words of the normalised text:
 *   EXACT    — the whole comment is the keyword ("narx!" but not "narxi")
 *   CONTAINS — the keyword appears as whole word(s) ("narx qancha" in
 *              "Salom, narx qancha?"), never inside another word
 *   intents  — any variant of a built-in intent, as whole words
 *
 * Pure: no database.
 */

import {
  foldDiacritics,
  normalizeArabicScript,
  stripSpecialCharacters,
} from "@/lib/utils/keyword-matcher";

// ─── Normaliser ───────────────────────────────────────────────────────────────

// Every apostrophe-like character Uzbek Latin is typed with (o‘, oʻ, o', o`,
// o’ ...). Removed, not turned into a space, so "to‘lov" stays one word.
const APOSTROPHES = /['‘’ʻʼʽ`´ʹ′‛]/gu;

// Uzbek Cyrillic (ў қ ғ ҳ) plus Russian, mapped to the official Uzbek Latin
// spelling. "е" is handled separately (ye / e depends on its position).
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ё: "yo", ж: "j", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
  ъ: "'", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
  ў: "o'", қ: "q", ғ: "g'", ҳ: "h",
};

const CYRILLIC_VOWELS = new Set(["а", "е", "ё", "и", "о", "у", "ы", "э", "ю", "я", "ў"]);

/** "е" is "ye" at the start of a word and after a vowel / ъ / ь ("ер" → "yer"). */
function transliterateCyrillic(lower: string): string {
  let out = "";
  let prev = "";
  for (const char of lower) {
    if (char === "е") {
      const wordStart = !prev || !/\p{L}/u.test(prev);
      out += wordStart || CYRILLIC_VOWELS.has(prev) || prev === "ъ" || prev === "ь" ? "ye" : "e";
    } else {
      out += CYRILLIC_TO_LATIN[char] ?? char;
    }
    prev = char;
  }
  return out;
}

/** The form every keyword, intent variant and comment is compared in. */
export function normalizeForMatch(text: string): string {
  const lower = (text ?? "").normalize("NFC").toLowerCase();
  const latin = transliterateCyrillic(lower).replace(APOSTROPHES, "");
  return foldDiacritics(stripSpecialCharacters(normalizeArabicScript(latin)))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `phrase` (already normalised) appears as whole word(s) in `text` (normalised). */
export function containsWords(normalizedText: string, normalizedPhrase: string): boolean {
  if (!normalizedText || !normalizedPhrase) return false;
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

export type KeywordMode = "EXACT" | "CONTAINS";

/** First keyword that matches, as the merchant typed it; null when none does. */
export function findKeyword(text: string, keywords: string[], mode: KeywordMode): string | null {
  const normalizedText = normalizeForMatch(text);
  if (!normalizedText) return null;
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForMatch(keyword);
    if (!normalizedKeyword) continue;
    const hit =
      mode === "EXACT" ? normalizedText === normalizedKeyword : containsWords(normalizedText, normalizedKeyword);
    if (hit) return keyword;
  }
  return null;
}

// ─── Built-in intents ─────────────────────────────────────────────────────────

export interface BuiltInIntent {
  key: string;
  /** Shown in the builder (Uzbek). */
  label: string;
  /** Variants in uz-Latn, uz-Cyrl and Russian; any one of them, as whole words, is a hit. */
  examples: string[];
}

export const BUILT_IN_INTENTS: BuiltInIntent[] = [
  {
    key: "PRICE",
    label: "Narx",
    examples: [
      "narx", "narxi", "narhi", "narh", "narxlari", "narxini", "narxi qancha", "qancha", "qanchadan",
      "qancha turadi", "necha pul", "nechpul", "nechi pul", "kancha", "prays", "praysi",
      "нарх", "нархи", "нархлари", "нархини", "қанча", "қанчадан", "канча", "неча пул", "нечпул",
      "цена", "цены", "цену", "ценник", "сколько", "сколько стоит", "почем", "почём", "стоимость", "прайс",
      "price", "how much", "cost",
    ],
  },
  {
    key: "ADDRESS",
    label: "Manzil",
    examples: [
      "manzil", "manzili", "manzilingiz", "manzilini", "adres", "adress", "qayerda", "qayerdasiz",
      "qaerda", "qaerdasiz", "joylashuv", "lokatsiya", "mo'ljal", "filial",
      "манзил", "манзили", "манзилингиз", "қаерда", "қаердасиз", "каерда", "мўлжал", "филиал",
      "адрес", "где", "где находитесь", "где вы находитесь", "локация", "ориентир",
      "address", "location",
    ],
  },
  {
    key: "CATALOG",
    label: "Katalog",
    examples: [
      "katalog", "katalogi", "katalogni", "assortiment", "tovarlar", "mahsulotlar", "modellar", "modellari",
      "каталог", "каталоги", "ассортимент", "товары", "маҳсулотлар", "моделлар", "модели",
      "catalog", "catalogue", "products",
    ],
  },
  {
    key: "ORDER",
    label: "Buyurtma",
    examples: [
      "buyurtma", "buyurtma berish", "buyurtma bermoqchiman", "zakaz", "zakas", "olmoqchiman",
      "sotib olmoqchiman", "sotib olish", "olaman",
      "буюртма", "буюртма бериш", "олмоқчиман", "сотиб олмоқчиман", "оламан",
      "заказ", "заказать", "хочу заказать", "хочу купить", "купить", "куплю", "оформить",
      "order", "buy",
    ],
  },
  {
    key: "DELIVERY",
    label: "Yetkazib berish",
    examples: [
      "dostavka", "yetkazib", "yetkazib berish", "yetkazib berasizmi", "yetkazish", "pochta",
      "етказиб", "етказиб бериш", "етказиб берасизми", "етказиш",
      "доставка", "доставкой", "доставляете", "есть доставка", "почта",
      "delivery", "shipping",
    ],
  },
  {
    key: "CONTACT",
    label: "Aloqa",
    examples: [
      "telefon", "telefon raqam", "raqam", "raqamingiz", "nomer", "aloqa", "bog'lanish", "bog'lanaman",
      "телефон", "рақам", "рақамингиз", "алоқа", "боғланиш",
      "номер", "контакт", "контакты", "связаться", "позвонить",
      "contact", "phone",
    ],
  },
  {
    key: "INFO",
    label: "Ma'lumot",
    examples: [
      "ma'lumot", "malumot", "batafsil", "qiziqtirdi", "info", "ma'lumot bering",
      "маълумот", "батафсил", "қизиқтирди",
      "подробнее", "информация", "инфо", "интересует", "детали",
      "information", "details",
    ],
  },
];

const INTENT_KEYS = new Set(BUILT_IN_INTENTS.map((intent) => intent.key));

export function isBuiltInIntent(key: string): boolean {
  return INTENT_KEYS.has(key);
}

// Normalised once: intent lists never change at runtime.
let normalizedIntents: Map<string, Array<{ example: string; normalized: string }>> | null = null;

function intentVariants(key: string) {
  if (!normalizedIntents) {
    normalizedIntents = new Map(
      BUILT_IN_INTENTS.map((intent) => [
        intent.key,
        intent.examples
          .map((example) => ({ example, normalized: normalizeForMatch(example) }))
          .filter((v) => v.normalized),
      ])
    );
  }
  return normalizedIntents.get(key) ?? [];
}

export interface IntentHit {
  intent: string;
  /** The variant that hit, as written in BUILT_IN_INTENTS. */
  example: string;
}

/** First of `intentKeys` (in the given order) that the text expresses. */
export function findIntent(text: string, intentKeys: string[]): IntentHit | null {
  const normalizedText = normalizeForMatch(text);
  if (!normalizedText) return null;
  for (const key of intentKeys) {
    for (const variant of intentVariants(key)) {
      if (containsWords(normalizedText, variant.normalized)) return { intent: key, example: variant.example };
    }
  }
  return null;
}
