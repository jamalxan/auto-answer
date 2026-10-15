import { describe, expect, it } from "vitest";
import {
  analyzeLanguage,
  detectLanguageV2,
  fromLegacyLang,
  replyLanguageInstruction,
  scriptFor,
  toLegacyLang,
} from "../lib/javobai/language";
import { detectLanguage } from "../lib/assistant/language";

describe("detectLanguageV2 — the TZ 21 test set", () => {
  it.each([
    ["Narxi qancha?", "uz-latn"],
    ["Нархи канча?", "uz-cyrl"],
    ["Сколько стоит?", "ru"],
    ["Салом, курс бор-ми?", "uz-cyrl"],
    ["Здравствуйте, курс есть?", "ru"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(detectLanguageV2(text)).toBe(expected);
  });

  it.each([["😊👍"], ["12345"], [""], ["   "], ["?!..."], ["+998 90 123 45 67"]])(
    "no letters (%j) -> unknown",
    (text) => {
      expect(detectLanguageV2(text)).toBe("unknown");
    }
  );
});

describe("detectLanguageV2 — Uzbek Cyrillic without ў/қ/ғ/ҳ", () => {
  it.each([
    ["Курс качон бошланади?", "uz-cyrl"],
    ["Салом! Онлайн курс борми?", "uz-cyrl"],
    ["Ассалому алайкум", "uz-cyrl"],
    ["Рахмат", "uz-cyrl"],
    ["Хоп, майли", "uz-cyrl"],
    ["Менга инглиз тили керак", "uz-cyrl"],
    ["Диван олмокчиман, нархи канча?", "uz-cyrl"],
    ["Манзилингиз каерда?", "uz-cyrl"],
    ["Дарслар кун давомида буладими?", "uz-cyrl"],
    ["Менга ўзбекча керак", "uz-cyrl"],
    ["Салом, диван борми? Нархи қанча", "uz-cyrl"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(detectLanguageV2(text)).toBe(expected);
  });
});

describe("detectLanguageV2 — Russian", () => {
  it.each([
    ["Здравствуйте, есть диваны?", "ru"],
    ["Сколько стоит доставка?", "ru"],
    ["Добрый день, хочу записаться на курс", "ru"],
    ["Привет", "ru"],
    ["Подскажите пожалуйста адрес", "ru"],
    ["Можно оплатить картой?", "ru"],
    ["Когда начинается следующая группа?", "ru"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(detectLanguageV2(text)).toBe(expected);
  });
});

/**
 * Regression: the Uzbek stoplists used to contain tokens Russian has too
 * (яна = the name Яна, бор, хам, хоп, ха) and the Russian list lacked the
 * commonest function words, so a Russian sentence with one such token read
 * as Uzbek Cyrillic — and production's templates answered a Russian customer
 * in Uzbek. Both detectors must agree on this set.
 */
const AMBIGUOUS_TOKEN_SET = [
  ["Меня зовут Яна, подскажите цену", "ru"],
  ["Добрый день, есть в наличии?", "ru"],
  ["Яна", "ru"],
  ["Я в Ташкенте, хочу бор", "ru"],
  ["Что за хам!", "ru"],
  ["Нархи канча?", "uz_cyrl"],
  ["Салом, курс бор-ми?", "uz_cyrl"],
  ["Хоп, майли", "uz_cyrl"],
  ["Рахмат", "uz_cyrl"],
  ["У ерда борми?", "uz_cyrl"],
] as const;

describe("ambiguous Uzbek / Russian tokens (regression)", () => {
  it.each(AMBIGUOUS_TOKEN_SET)("v2: %s -> %s", (text, expected) => {
    expect(detectLanguageV2(text)).toBe(fromLegacyLang(expected));
  });

  it.each(AMBIGUOUS_TOKEN_SET)("production: %s -> %s", (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });
});

describe("detectLanguageV2 — mixed scripts and ties", () => {
  it("mixed scripts go to the majority", () => {
    expect(detectLanguageV2("Salom, Iphone 15 Pro Max narxi qancha? (белый)")).toBe("uz-latn");
    expect(detectLanguageV2("Здравствуйте, iPhone есть в наличии?")).toBe("ru");
    expect(detectLanguageV2("Салом, Samsung борми?")).toBe("uz-cyrl");
  });

  it("Latin letters, no Uzbek words, is still Uzbek Latin (no Latin Russian in the product)", () => {
    expect(detectLanguageV2("Ok")).toBe("uz-latn");
    expect(detectLanguageV2("Iphone 15")).toBe("uz-latn");
  });

  it("a Cyrillic word with no evidence keeps the previous Cyrillic language, else Russian", () => {
    expect(detectLanguageV2("Ок")).toBe("ru");
    expect(detectLanguageV2("Ок", "uz-cyrl")).toBe("uz-cyrl");
    expect(detectLanguageV2("Диван", "ru")).toBe("ru");
    // `previous` never overrides real evidence or the script.
    expect(detectLanguageV2("Нархи канча?", "ru")).toBe("uz-cyrl");
    expect(detectLanguageV2("Narxi qancha?", "ru")).toBe("uz-latn");
  });

  it("explains its scores", () => {
    const evidence = analyzeLanguage("Нархи канча?");
    expect(evidence.lang).toBe("uz-cyrl");
    expect(evidence.script).toBe("cyrl");
    expect(evidence.uzScore).toBeGreaterThan(evidence.ruScore);
    expect(analyzeLanguage("🙂").script).toBeNull();
  });
});

describe("script and prompt helpers", () => {
  it("scriptFor", () => {
    expect(scriptFor("uz-latn")).toBe("latn");
    expect(scriptFor("uz-cyrl")).toBe("cyrl");
    expect(scriptFor("ru")).toBe("cyrl");
    expect(scriptFor("unknown")).toBe("latn");
  });

  it("maps to and from production's Lang", () => {
    expect(toLegacyLang("uz-latn")).toBe("uz_latn");
    expect(toLegacyLang("uz-cyrl")).toBe("uz_cyrl");
    expect(toLegacyLang("ru")).toBe("ru");
    expect(toLegacyLang("unknown")).toBe("uz_latn");
    expect(fromLegacyLang("uz_cyrl")).toBe("uz-cyrl");
    expect(fromLegacyLang("uz-latn")).toBe("uz-latn");
    expect(fromLegacyLang(null)).toBe("unknown");
    expect(fromLegacyLang("other")).toBe("unknown");
  });

  it("replyLanguageInstruction names the language, the script and the rule", () => {
    const latn = replyLanguageInstruction("uz-latn");
    expect(latn).toMatch(/^JAVOB TILI: o'zbek tili, LOTIN/);
    expect(replyLanguageInstruction("uz-cyrl")).toMatch(/KIRILL/);
    expect(replyLanguageInstruction("ru")).toMatch(/rus tili/);
    const unknown = replyLanguageInstruction("unknown");
    expect(unknown).toMatch(/LOTIN/);
    expect(unknown).toMatch(/aniqlanmadi/);
    for (const lang of ["uz-latn", "uz-cyrl", "ru", "unknown"] as const) {
      const line = replyLanguageInstruction(lang);
      expect(line).toContain("shu tilda va shu yozuvda");
      expect(line).toContain("lotin yozuvida javob ber");
      expect(line).not.toContain("\n");
    }
  });
});

describe("production detectLanguage still agrees on the shared set", () => {
  it.each([
    ["Narxi qancha?", "uz_latn"],
    ["Нархи канча?", "uz_cyrl"],
    ["Сколько стоит?", "ru"],
    ["Салом, курс бор-ми?", "uz_cyrl"],
    ["Здравствуйте, курс есть?", "ru"],
    ["Курс качон бошланади?", "uz_cyrl"],
    ["Хоп, майли", "uz_cyrl"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });
});
