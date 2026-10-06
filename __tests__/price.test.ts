import { describe, expect, it } from "vitest";
import { extractPriceMentions, formatPrice, parsePrice } from "../lib/assistant/price";

describe("parsePrice", () => {
  const cases: Array<[string, number | null, string, boolean]> = [
    ["1 200 000", 1_200_000, "UZS", false],
    ["1.200.000", 1_200_000, "UZS", false],
    ["1,200,000", 1_200_000, "UZS", false],
    ["1,2 mln", 1_200_000, "UZS", false],
    ["1.2 million", 1_200_000, "UZS", false],
    ["2 mln", 2_000_000, "UZS", false],
    ["2,5 млн", 2_500_000, "UZS", false],
    ["300 ming", 300_000, "UZS", false],
    ["300k", 300_000, "UZS", false],
    ["300 тыс", 300_000, "UZS", false],
    ["350 000 so'm", 350_000, "UZS", false],
    ["350 000 сум", 350_000, "UZS", false],
    ["350000 сўм", 350_000, "UZS", false],
    ["$300", 300, "USD", false],
    ["300 dollar", 300, "USD", false],
    ["300 $", 300, "USD", false],
    ["$12.50", 12.5, "USD", false],
    ["от 500 000", 500_000, "UZS", true],
    ["от 500 000 сум", 500_000, "UZS", true],
    ["500 000 dan", 500_000, "UZS", true],
    ["500 000 so'mdan", 500_000, "UZS", true],
    ["500 000 дан", 500_000, "UZS", true],
    ["from 100", 100, "UZS", true],
    ["1 mlrd", 1_000_000_000, "UZS", false],
    ["4 500 000 so'm", 4_500_000, "UZS", false],
    ["15000 руб", 15_000, "RUB", false],
    ["  250 000  ", 250_000, "UZS", false],
  ];

  it.each(cases)("%s", (input, amount, currency, isFrom) => {
    const parsed = parsePrice(input);
    expect(parsed.amount).toBe(amount);
    expect(parsed.currency).toBe(currency);
    expect(parsed.isFrom).toBe(isFrom);
  });

  it("returns null for text with no number", () => {
    expect(parsePrice("kelishiladi").amount).toBeNull();
    expect(parsePrice("narxi yo'q").amount).toBeNull();
    expect(parsePrice("").amount).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parsePrice("0").amount).toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats UZS with grouping", () => {
    expect(formatPrice(4_500_000)).toBe("4 500 000 so'm");
  });
  it("formats a from price", () => {
    expect(formatPrice(3_200_000, "UZS", true)).toBe("3 200 000 so'mdan");
  });
  it("formats USD", () => {
    expect(formatPrice(300, "USD")).toBe("$300");
  });
  it("handles null", () => {
    expect(formatPrice(null)).toBe("narx ko'rsatilmagan");
  });
});

describe("extractPriceMentions", () => {
  it("finds a UZS price", () => {
    expect(extractPriceMentions("Narxi 4 500 000 so'm")).toEqual([
      { amount: 4_500_000, currency: "UZS" },
    ]);
  });
  it("finds a USD price", () => {
    expect(extractPriceMentions("Atigi $300")).toEqual([{ amount: 300, currency: "USD" }]);
  });
  it("finds a price in mln", () => {
    expect(extractPriceMentions("Taxminan 3 mln")[0]?.amount).toBe(3_000_000);
  });
  it("finds bare big numbers", () => {
    expect(extractPriceMentions("4500000 turadi")[0]?.amount).toBe(4_500_000);
  });
  it("ignores small harmless numbers", () => {
    expect(extractPriceMentions("2 ta divan, 3 xil rang")).toEqual([]);
  });
  it("finds nothing in plain text", () => {
    expect(extractPriceMentions("Assalomu alaykum!")).toEqual([]);
  });
});
