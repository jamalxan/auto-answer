import { describe, expect, it } from "vitest";
import { uzLatinToCyrillic as t } from "@/lib/i18n/translit";

describe("uz latin -> cyrillic", () => {
  it("handles digraphs and apostrophe letters", () => {
    expect(t("Saqlash")).toBe("Сақлаш");
    expect(t("shahar choy")).toBe("шаҳар чой");
    expect(t("o'zbek g'oya")).toBe("ўзбек ғоя");
    expect(t("Bo'lim")).toBe("Бўлим");
    expect(t("yo'l yosh yuz yaxshi")).toBe("йўл ёш юз яхши");
    expect(t("ma'no")).toBe("маъно");
    expect(t("tong")).toBe("тонг");
  });
  it("e at word start is э, elsewhere е; ye is е", () => {
    expect(t("eshik")).toBe("эшик");
    expect(t("kelgan")).toBe("келган");
    expect(t("yetti")).toBe("етти");
  });
  it("keeps case, punctuation, digits and non-latin text", () => {
    expect(t("SHAHAR")).toBe("ШАҲАР");
    expect(t("Xato: 3 ta ‘o’zgarish’.")).toBe("Хато: 3 та ‘ўзгариш’.");
    expect(t("Привет")).toBe("Привет");
  });
  it("does not touch urls, emails, ids, camelCase and brands", () => {
    expect(t("https://socialauto.uz/leads")).toBe("https://socialauto.uz/leads");
    expect(t("a@b.uz")).toBe("a@b.uz");
    expect(t("PRICE_ASKED gpt4 amoCRM Instagram")).toBe("PRICE_ASKED gpt4 amoCRM Instagram");
    expect(t("Instagram ulash")).toBe("Instagram улаш");
  });
});
