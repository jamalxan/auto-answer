export type Lang = "uz_latn" | "uz_cyrl" | "ru";

const UZ_CYRL_LETTERS = /[ўқғҳЎҚҒҲ]/;
const RU_ONLY_LETTERS = /[ыэёщъЫЭЁЩЪ]/;
// Whole Cyrillic words. `\b` cannot be used here: in a JavaScript regex it
// only sees ASCII word characters, so `\bнархи\b` never matches and the
// lists below were dead code — every Cyrillic text without ў/қ/ғ/ҳ came back
// Russian. Includes the keyboard-less spellings (канча, качон, йук, хўп…);
// only words Russian does not have — so NOT яна (the name Яна), бор, хам,
// хоп, ха: one of those in a Russian sentence must never read as Uzbek.
const UZ_CYRL_WORDS =
  /(?<!\p{L})(ва|учун|керак|керакми|борми|нима|қанча|канча|нархи|нарх|салом|ассалому|алайкум|раҳмат|рахмат|йўқ|йук|ҳа|қилиб|менга|сизда|бизда|билан|қачон|качон|қаерда|каерда|мумкинми|бўлади|булади|бўладими|буладими|олмоқчиман|олмокчиман|хўп|майли|яхши|ҳам|жуда|ёки|сўм|минг|бошланади|манзил|манзилингиз|етказиб)(?!\p{L})/iu;
// High-frequency Russian function words and greetings. "у" stays out: it is
// also the Uzbek pronoun ("у ерда").
const RU_WORDS =
  /(?<!\p{L})(и|в|на|не|что|я|вы|с|по|это|для|нужно|есть|как|где|когда|сколько|привет|здравствуйте|добрый|спасибо|пожалуйста|подскажите|меня|зовут|нет|да|мне|можно|хочу|цена|стоит)(?!\p{L})/iu;

/**
 * Cheap deterministic language guess from the customer's text. The LLM also
 * reports `language`, but code needs a value for templates when the LLM is down.
 */
export function detectLanguage(text: string, fallback: Lang = "uz_latn"): Lang {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return fallback;
  const cyrillic = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;

  if (cyrillic / letters.length < 0.5) return "uz_latn";
  if (UZ_CYRL_LETTERS.test(text)) return "uz_cyrl";
  if (RU_ONLY_LETTERS.test(text)) return "ru";
  if (UZ_CYRL_WORDS.test(text) && !RU_WORDS.test(text)) return "uz_cyrl";
  return "ru";
}

export function normalizeLang(value: unknown, fallback: Lang): Lang {
  return value === "uz_latn" || value === "uz_cyrl" || value === "ru" ? value : fallback;
}
