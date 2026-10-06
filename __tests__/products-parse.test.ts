import { describe, expect, it } from "vitest";
import {
  looksLikeProductList,
  parseCsvText,
  parseProductLine,
  parseProductText,
  parseTable,
} from "../lib/assistant/products-parse";

describe("parseProductLine", () => {
  it("name — price", () => {
    expect(parseProductLine('Burchakli divan "Milan" — 4 500 000 so\'m')).toMatchObject({
      name: 'Burchakli divan "Milan"',
      price: 4_500_000,
      priceIsFrom: false,
    });
  });
  it("detects a from-price", () => {
    expect(parseProductLine("To'g'ri divan Oslo — 3 200 000 so'mdan")).toMatchObject({
      price: 3_200_000,
      priceIsFrom: true,
    });
  });
  it("accepts a hyphen separator and mln", () => {
    expect(parseProductLine("Kreslo - 1,2 mln")).toMatchObject({ name: "Kreslo", price: 1_200_000 });
  });
  it("accepts a colon separator and k", () => {
    expect(parseProductLine("Stul: 300k")).toMatchObject({ name: "Stul", price: 300_000 });
  });
  it("accepts dollars", () => {
    expect(parseProductLine("Laptop — $300")).toMatchObject({ price: 300, currency: "USD" });
  });
  it("works without a separator", () => {
    expect(parseProductLine("Stol 1 200 000")).toMatchObject({ name: "Stol", price: 1_200_000 });
  });
  it("keeps digits that belong to the name", () => {
    expect(parseProductLine("Divan 3 o'rinli — 4 500 000")).toMatchObject({
      name: "Divan 3 o'rinli",
      price: 4_500_000,
    });
  });
  it("strips list numbering and bullets", () => {
    expect(parseProductLine("1. Kreslo — 900 000")?.name).toBe("Kreslo");
    expect(parseProductLine("• Kreslo — 900 000")?.name).toBe("Kreslo");
  });
  it("a bare name has no price", () => {
    expect(parseProductLine("Kreslo")).toMatchObject({ name: "Kreslo", price: null, priceUnclear: false });
  });
  it("flags an unreadable price for a re-ask", () => {
    const p = parseProductLine("Kreslo — 5-6 ming atrofida kelishiladi");
    expect(p?.name).toBe("Kreslo");
    expect(p?.price).not.toBe(0);
  });
  it("returns null for junk", () => {
    expect(parseProductLine("")).toBeNull();
    expect(parseProductLine("123")).toBeNull();
  });
});

describe("parseProductText", () => {
  it("parses a multi-line list", () => {
    const list = parseProductText("Milan — 4 500 000\nOslo — 3.200.000\nKreslo\n\nStol - 1,5 mln");
    expect(list.map((p) => p.price)).toEqual([4_500_000, 3_200_000, null, 1_500_000]);
  });
  it("recognizes list-like text", () => {
    expect(looksLikeProductList("Milan — 4 500 000\nOslo — 3 200 000")).toBe(true);
    expect(looksLikeProductList("Biz divan sotamiz, sifatli va arzon, hamma turlari bor")).toBe(false);
  });
});

describe("tables", () => {
  it("maps name and price columns by header", () => {
    const rows = [
      ["Nomi", "Narx", "Izoh"],
      ["Milan", "4 500 000", "burchakli"],
      ["Oslo", "от 3 200 000", ""],
    ];
    const list = parseTable(rows);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: "Milan", price: 4_500_000, note: "burchakli" });
    expect(list[1]).toMatchObject({ price: 3_200_000, priceIsFrom: true });
  });
  it("understands Russian headers", () => {
    const list = parseTable([["Наименование", "Цена"], ["Диван", "4500000"]]);
    expect(list[0]).toMatchObject({ name: "Диван", price: 4_500_000 });
  });
  it("falls back to the first two columns without a header", () => {
    const list = parseTable([["Milan", "4500000"], ["Oslo", "3200000"]]);
    expect(list).toHaveLength(2);
  });
  it("parses CSV text", () => {
    const list = parseCsvText("nom,narx\nMilan,4500000\nOslo,3200000\n");
    expect(list.map((p) => p.name)).toEqual(["Milan", "Oslo"]);
  });
  it("a 15-row price list gives 15 products (acceptance #16)", () => {
    const rows = [["nom", "narx"], ...Array.from({ length: 15 }, (_, i) => [`Mahsulot ${i + 1}`, String((i + 1) * 100_000)])];
    expect(parseTable(rows)).toHaveLength(15);
  });
  it("caps at 500 rows", () => {
    const rows = [["nom", "narx"], ...Array.from({ length: 700 }, (_, i) => [`P${i}`, "1000"])];
    expect(parseTable(rows)).toHaveLength(500);
  });
});
