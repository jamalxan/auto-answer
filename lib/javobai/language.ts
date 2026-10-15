/**
 * JavobAI language detection v2 (TZ 21, ETAP 4.2).
 *
 * Production's `detectLanguage` (lib/assistant/language.ts) tells Uzbek
 * Cyrillic from Russian mostly by the four Uzbek letters (ў қ ғ ҳ). Real
 * customers type Uzbek Cyrillic on Russian keyboards without them ("Нархи
 * канча?", "Курс качон бошланади?"), so this detector scores evidence instead:
 *
 *   letters   ў қ ғ ҳ → Uzbek;  ы → Russian;  щ → Russian (weaker)
 *   words     stoplists of common Uzbek words (standard and keyboard-less
 *             spellings) vs common Russian words
 *   endings   Uzbek suffixes (-ми -лар -нинг -дан -моқчи -ман -ди …) vs
 *             Russian endings (-ть -ться -ете -ый -ая -ого -ение …)
 *
 * Mixed scripts go to the majority script. Latin text is Uzbek Latin (the
 * product has no Latin-script Russian customers). No letters → "unknown".
 * Pure: no database, no LLM.
 */

import type { Lang } from "@/lib/assistant/language";

export type LangV2 = "uz-latn" | "uz-cyrl" | "ru" | "unknown";
export type Script = "latn" | "cyrl";

// ─── Evidence tables ──────────────────────────────────────────────────────────

const UZ_LETTERS = /[ўқғҳ]/g;
/** Never written in Uzbek. */
const RU_STRONG_LETTERS = /[ы]/g;
/** Rare in Uzbek (loan words only). */
const RU_WEAK_LETTERS = /[щ]/g;

/**
 * Common Uzbek words in Cyrillic, with and without the Uzbek letters, as
 * people type them. Only words Russian does not have — so NOT яна (the name
 * Яна), бор, хам, хоп, ха: a Russian sentence with one of those must not
 * pick up Uzbek evidence.
 */
const UZ_WORDS = new Set([
  "нарх", "нархи", "нархлари", "нархини", "канча", "қанча", "кача", "канчадан", "қанчадан",
  "борми", "йўқ", "йук", "йок", "йўқми", "йукми", "керак", "керакми", "сизда", "бизда",
  "учун", "билан", "салом", "ассалому", "ассалом", "алайкум", "алейкум", "рахмат", "раҳмат",
  "ҳа", "хўп", "хуп", "майли", "яхши", "нима", "нега", "қачон", "качон",
  "қаерда", "каерда", "қаерга", "каерга", "қайси", "кайси", "менга", "бизга", "сизга",
  "мумкинми", "мумкин", "бўлади", "булади", "бўладими", "буладими", "қилиш", "килиш",
  "олмоқчиман", "олмокчиман", "олмоқчи", "олмокчи", "сотиб", "олиш", "тўлов", "тулов",
  "манзил", "манзили", "манзилингиз", "етказиб", "етказасизми", "иложи", "ҳам",
  "жуда", "лекин", "ёки", "ва", "деб", "кун", "соат", "пул", "сўм", "сум", "минг",
  "бошланади", "бошлайди", "гурух", "гуруҳ", "дарс", "дарслар", "ўқиш", "укиш", "ўргатасизми",
  "ургатасизми", "исмим", "рақам", "ракам", "раками", "телефоним", "мен", "сиз", "биз",
  "керакмас", "йўқми", "борми", "кандай", "қандай", "неча", "нечта", "нечпул", "турадими",
  "беринг", "айтинг", "ёзинг", "езинг", "юборинг", "ташланг", "бормикан", "бўлса", "булса",
  "кейин", "олдин", "ҳозир", "хозир", "бугун", "эртага", "келаман", "бораман", "оламан",
]);

/**
 * Common Russian words. Skips words shared with Uzbek Cyrillic as typed
 * (курс, онлайн, доставка…) — those carry no language signal; "у" is also
 * the Uzbek pronoun ("у ерда"), so it stays out.
 */
const RU_WORDS = new Set([
  "сколько", "стоит", "стоимость", "цена", "цены", "цену", "есть", "можно", "нужно", "надо",
  "здравствуйте", "привет", "добрый", "день", "вечер", "утро", "где", "как", "что", "чтобы",
  "для", "хочу", "хотел", "хотела", "хотим", "спасибо", "пожалуйста", "подскажите", "скажите",
  "меня", "зовут", "когда",
  "нет", "да", "мне", "вы", "вас", "вам", "я", "мы", "нас", "нам", "на", "в", "во", "с", "со",
  "по", "это", "эта", "этот", "ли", "или", "и", "а", "но", "не", "от", "до", "за", "к",
  "какой", "какая", "какие", "какое", "когда", "почему", "сейчас", "сегодня", "завтра",
  "купить", "заказать", "заказ", "оплата", "оплатить", "адрес", "телефон", "номер",
  "записаться", "запись", "интересует", "подробнее", "информация", "ещё", "еще", "уже",
  "будет", "было", "быть", "могу", "можете", "работаете", "открыты", "там", "здесь", "тут",
  "очень", "только", "также", "тоже", "ответьте", "напишите", "пришлите", "отправьте",
  "рублей", "сум", "сумов", "скидка", "скидки", "акция", "рассрочка", "бесплатно", "платно",
]);

/** Uzbek suffixes a Cyrillic word of ≥ 4 letters may end with. Longest first. */
const UZ_SUFFIXES = [
  "моқчиман", "мокчиман", "ларингиз", "ларимиз", "ларини", "ларига", "ларда", "лардан", "ларни",
  "моқчи", "мокчи", "ингиз", "нинг", "лар", "дан", "миз", "сиз", "ман", "ган", "ади", "яди",
  "ди", "ми", "ни", "га", "да", "им", "инг", "чи", "лик",
];

/** Russian endings a Cyrillic word of ≥ 4 letters may end with. Longest first. */
const RU_SUFFIXES = [
  "ться", "ение", "ание", "ость", "ство", "ский", "ская", "ские", "ого", "ему", "ому", "ете",
  "ите", "ует", "ают", "яют", "ешь", "ишь", "ать", "ять", "ить", "еть", "уть", "ыть", "ть",
  "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ом", "ем", "ах", "ях", "ов", "ев",
  "ия", "ью", "ой", "ей",
];

const WEIGHTS = {
  uzLetter: 3,
  ruStrongLetter: 3,
  ruWeakLetter: 2,
  word: 2,
  /** The question particle "ми" written as a separate word ("бор ми", "бор-ми"). */
  uzParticle: 2,
  suffix: 1,
} as const;

// ─── Detection ────────────────────────────────────────────────────────────────

function cyrillicWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{Script=Cyrillic}]+/gu) ?? [];
}

function endsWithAny(word: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => word.length > suffix.length + 1 && word.endsWith(suffix));
}

export interface LanguageEvidence {
  lang: LangV2;
  script: Script | null;
  latinLetters: number;
  cyrillicLetters: number;
  uzScore: number;
  ruScore: number;
}

/**
 * The detector with its working shown — the dev UI's sandbox can display why
 * a message was classified the way it was.
 */
export function analyzeLanguage(text: string, previous?: LangV2 | null): LanguageEvidence {
  const letters = (text ?? "").match(/\p{L}/gu) ?? [];
  const latinLetters = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  const cyrillicLetters = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  const base = { latinLetters, cyrillicLetters, uzScore: 0, ruScore: 0 };

  if (latinLetters === 0 && cyrillicLetters === 0) return { ...base, lang: "unknown", script: null };
  // Majority script. Equal counts: Cyrillic is the deliberate choice (a
  // Russian keyboard), Latin may be a product name.
  if (latinLetters > cyrillicLetters) return { ...base, lang: "uz-latn", script: "latn" };

  const lower = (text ?? "").toLowerCase();
  let uzScore = (lower.match(UZ_LETTERS)?.length ?? 0) * WEIGHTS.uzLetter;
  let ruScore =
    (lower.match(RU_STRONG_LETTERS)?.length ?? 0) * WEIGHTS.ruStrongLetter +
    (lower.match(RU_WEAK_LETTERS)?.length ?? 0) * WEIGHTS.ruWeakLetter;

  for (const word of cyrillicWords(lower)) {
    if (word === "ми") {
      uzScore += WEIGHTS.uzParticle;
      continue;
    }
    const uzWord = UZ_WORDS.has(word);
    const ruWord = RU_WORDS.has(word);
    if (uzWord && !ruWord) uzScore += WEIGHTS.word;
    else if (ruWord && !uzWord) ruScore += WEIGHTS.word;
    if (uzWord || ruWord || word.length < 4) continue;
    // Unknown word: its ending is weak evidence.
    if (endsWithAny(word, UZ_SUFFIXES)) uzScore += WEIGHTS.suffix;
    if (endsWithAny(word, RU_SUFFIXES)) ruScore += WEIGHTS.suffix;
  }

  let lang: LangV2;
  if (uzScore > ruScore) lang = "uz-cyrl";
  else if (ruScore > uzScore) lang = "ru";
  // No evidence either way ("Ок", "Диван"): keep what the customer wrote in
  // before, in the same script; a fresh thread defaults to Russian like
  // production does.
  else lang = previous === "uz-cyrl" || previous === "ru" ? previous : "ru";

  return { ...base, lang, script: "cyrl", uzScore, ruScore };
}

/**
 * Language and script of a customer message. `previous` (the language of
 * the earlier turns) only breaks ties between Uzbek Cyrillic and Russian.
 */
export function detectLanguageV2(text: string, previous?: LangV2 | null): LangV2 {
  return analyzeLanguage(text, previous).lang;
}

export function scriptFor(lang: LangV2): Script {
  return lang === "uz-cyrl" || lang === "ru" ? "cyrl" : "latn";
}

/** Production's three-value `Lang` (templates, Lead.language). Unknown → Uzbek Latin. */
export function toLegacyLang(lang: LangV2): Lang {
  switch (lang) {
    case "uz-cyrl":
      return "uz_cyrl";
    case "ru":
      return "ru";
    default:
      return "uz_latn";
  }
}

export function fromLegacyLang(lang: Lang | string | null | undefined): LangV2 {
  switch (lang) {
    case "uz_latn":
    case "uz-latn":
      return "uz-latn";
    case "uz_cyrl":
    case "uz-cyrl":
      return "uz-cyrl";
    case "ru":
      return "ru";
    default:
      return "unknown";
  }
}

const LANG_LABEL: Record<LangV2, string> = {
  "uz-latn": "o'zbek tili, LOTIN yozuvi",
  "uz-cyrl": "o'zbek tili, KIRILL yozuvi (masalan: \"Салом! Курс нархи 450 000 сўм.\")",
  ru: "rus tili, kirill yozuvi (masalan: \"Здравствуйте! Курс стоит 450 000 сум.\")",
  unknown: "o'zbek tili, LOTIN yozuvi (mijozning tili aniqlanmadi)",
};

/**
 * The "JAVOB TILI" line of the system prompt: reply in the customer's
 * language and script; unknown → Uzbek Latin.
 */
export function replyLanguageInstruction(lang: LangV2): string {
  return [
    `JAVOB TILI: ${LANG_LABEL[lang]}.`,
    "Qoida: mijoz qaysi tilda va qaysi yozuvda (lotin / kirill) yozsa, javobni xuddi shu tilda va shu yozuvda ber;",
    "tilini aniqlab bo'lmasa (faqat emoji, raqam yoki bitta so'z) — o'zbek tilida, lotin yozuvida javob ber.",
    "Mijoz tilni almashtirsa, keyingi javobdan boshlab yangi tilga o't. Tillarni bir javobda aralashtirma.",
  ].join(" ");
}
