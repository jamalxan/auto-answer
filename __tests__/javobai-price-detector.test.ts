import { describe, expect, it } from "vitest";
import { detectsPriceQuestion } from "../lib/javobai/price-detector";

const UZ_LATIN = [
  "Salom, narxi qancha?",
  "narx qancha",
  "Narxi?",
  "Bu divan necha pul?",
  "necha so'm turadi",
  "Qancha bo'ladi?",
  "NARXLARI QANCHA!!!",
  "narxini ayting iltimos",
  "Assalomu alaykum, qancha turadi bu?",
  "Narxlar haqida malumot bering",
  "o` narx qancha???",
  "bahosi qancha",
];
const UZ_CYRILLIC = [
  "Салом, нархи қанча?",
  "нарх қанча",
  "Нархи?",
  "Бу диван неча пул?",
  "неча сўм туради",
  "Қанча бўлади?",
  "НАРХЛАРИ ҚАНЧА!!!",
  "нархини айтинг илтимос",
  "Ассалому алайкум, қанча туради бу?",
  "Нархлар ҳақида маълумот беринг",
  "канча туради",
];
const RU = ["Сколько стоит диван?", "Здравствуйте, какая цена?", "Почём сегодня?", "цена?", "Скажите стоимость", "Сколько это будет?", "Пришлите прайс"];
const EN = ["How much is it?", "what is the price?", "PRICE?", "how much does it cost", "Pricing please"];
const NOT_PRICE = ["Salom", "Divan bormi?", "Manzilingiz qayerda?", "Привет", "Какой цвет есть?", "Hello there", "Yetkazib berasizmi?", "Рахмат", "Rahmat katta", "ish vaqti qanday"];

describe("deterministic price detector (B-05)", () => {
  it.each([["uz latin", UZ_LATIN], ["uz cyrillic", UZ_CYRILLIC], ["ru", RU], ["en", EN]])("recognises %s phrases (>= 95%%)", (_name, phrases) => {
    const hits = phrases.filter((p) => detectsPriceQuestion(p));
    expect(hits.length / phrases.length).toBeGreaterThanOrEqual(0.95);
    expect(phrases.length).toBeGreaterThanOrEqual(5);
  });

  it("has at least ten phrases per Uzbek alphabet", () => {
    expect(UZ_LATIN.length).toBeGreaterThanOrEqual(10);
    expect(UZ_CYRILLIC.length).toBeGreaterThanOrEqual(10);
  });

  it("does not fire on non-price messages", () => {
    for (const p of NOT_PRICE) expect(detectsPriceQuestion(p), p).toBe(false);
  });

  it("tolerates apostrophe variants and handles empty input", () => {
    expect(detectsPriceQuestion("necha so’m")).toBe(true);
    expect(detectsPriceQuestion("necha soʻm")).toBe(true);
    expect(detectsPriceQuestion("")).toBe(false);
    expect(detectsPriceQuestion(null)).toBe(false);
  });

  it("matches on word boundaries, not substrings", () => {
    for (const p of ["anarx", "почему так", "оценка 5", "costume party", "Qancha vaqt ichida yetkazasiz?", "сколько времени", "сколько вас", "how much time", "Yetkazish qancha vaqt oladi", "Qancha odam bor?", "Сколько человек?", "Почему не отвечаете", "Оцените, пожалуйста", "Мне нужна доставка", "Qancha kun ichida keladi", "Скольких людей", "priceless moment"]) {
      expect(detectsPriceQuestion(p), p).toBe(false);
    }
  });

  it("keeps real price questions with suffixes and context", () => {
    for (const p of ["narxlari qancha", "Qancha turadi?", "qancha bo'ladi bu", "нечта пул", "сколько стоит", "Сколько стоят?", "how much is the sofa", "how much does it cost", "почём?", "Цены?", "What are the costs", "narxi"]) {
      expect(detectsPriceQuestion(p), p).toBe(true);
    }
  });
});
