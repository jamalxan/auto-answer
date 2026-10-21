import { describe, expect, it } from "vitest";
import { baseLocale, isUiLocale } from "@/lib/i18n/config";
import { translateText } from "@/lib/i18n/dom-translate";
import { phrasesEn } from "@/lib/i18n/dev-phrases-en";
import { phrasesRu } from "@/lib/i18n/dev-phrases-ru";

describe("ui locales", () => {
  it("accepts uz-Cyrl and maps it to the Uzbek content locale", () => {
    expect(isUiLocale("uz-Cyrl")).toBe(true);
    expect(isUiLocale("de")).toBe(false);
    expect(baseLocale("uz-Cyrl")).toBe("uz");
    expect(baseLocale("ru")).toBe("ru");
  });
});

describe("translateText", () => {
  it("leaves Uzbek Latin untouched", () => {
    expect(translateText("Saqlash", "uz")).toBe("Saqlash");
  });
  it("transliterates for uz-Cyrl and keeps whitespace", () => {
    expect(translateText(" Saqlash ", "uz-Cyrl")).toBe(" Сақлаш ");
  });
  it("uses the phrase table for ru/en with whitespace kept and unknown text unchanged", () => {
    const ru = Object.keys(phrasesRu)[0];
    expect(translateText(`  ${ru} `, "ru", phrasesRu)).toBe(`  ${phrasesRu[ru]} `);
    const en = Object.keys(phrasesEn)[0];
    expect(translateText(en, "en", phrasesEn)).toBe(phrasesEn[en]);
    expect(translateText("zzz noma'lum", "ru", phrasesRu)).toBe("zzz noma'lum");
  });
  it("tables are populated", () => {
    expect(Object.keys(phrasesRu).length).toBeGreaterThan(1000);
    expect(Object.keys(phrasesEn).length).toBeGreaterThan(1000);
  });
});
