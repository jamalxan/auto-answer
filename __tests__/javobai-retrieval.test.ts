import { describe, expect, it } from "vitest";
import {
  levenshtein,
  queryTokens,
  rankByQuery,
  selectFaqsV2,
  selectProductsV2,
  type RetrievalItem,
} from "../lib/javobai/retrieval";

const items: RetrievalItem[] = [
  { id: "p1", text: "Ingliz tili kursi" },
  { id: "p2", text: "Rus tili kursi" },
  { id: "p3", text: "IELTS tayyorlov" },
  { id: "p4", text: "Divan Milan (3 o'rinli)" },
  { id: "p5", text: "Narx ro'yxati" },
  { id: "p6", text: "Стол обеденный" },
];

describe("queryTokens", () => {
  it("normalises, transliterates and drops stop words", () => {
    expect(queryTokens("Ingliz tili kursi narxi qancha?")).toEqual(["ingliz", "tili", "kursi"]);
    expect(queryTokens("Сколько стоит курс английского?")).toEqual(["kurs", "angliyskogo"]);
    expect(queryTokens("O‘zbek tili")).toEqual(["ozbek", "tili"]);
  });
  it("de-duplicates", () => {
    expect(queryTokens("divan divan Диван")).toEqual(["divan"]);
  });
  it("keeps stop words when nothing else is left", () => {
    expect(queryTokens("Нархи канча?")).toEqual(["narxi", "kancha"]);
    expect(queryTokens("🙂 ?")).toEqual([]);
  });
});

describe("levenshtein", () => {
  it("counts edits and stops early past max", () => {
    expect(levenshtein("divan", "divan")).toBe(0);
    expect(levenshtein("divan", "devan")).toBe(1);
    expect(levenshtein("divan", "divann")).toBe(1);
    expect(levenshtein("divan", "stol", 1)).toBeGreaterThan(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("rankByQuery", () => {
  it("matches a Cyrillic query to Latin texts", () => {
    const ranked = rankByQuery("Инглиз тили курси борми?", items);
    expect(ranked[0].id).toBe("p1");
    expect(ranked.map((r) => r.id)).toContain("p2"); // "tili kursi"
  });

  it("matches a Latin query to a Cyrillic text", () => {
    expect(rankByQuery("stol bormi", items).map((r) => r.id)).toEqual(["p6"]);
  });

  it("Russian 'цена курса' matches 'kursi' / 'kurs' through the shared stem", () => {
    const ranked = rankByQuery("цена курса", items);
    expect(ranked.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(ranked[0].score).toBe(2);
    expect(rankByQuery("цена курса", [{ id: "k", text: "Kurs" }, { id: "l", text: "Kurslar" }]).map((r) => r.id)).toEqual(["k", "l"]);
    // Russian declension against a Russian-named product.
    expect(rankByQuery("курс английского", [{ id: "e", text: "Английский язык" }]).map((r) => r.id)).toEqual(["e"]);
  });

  it("Cyrillic 'Нархи' matches a Latin product 'Narx' and vice versa", () => {
    const products = [{ id: "a", text: "Divan" }, { id: "b", text: "Narx" }];
    expect(rankByQuery("Нархи", products).map((r) => r.id)).toEqual(["b"]);
    expect(rankByQuery("Narxi", [{ id: "c", text: "Нарх" }]).map((r) => r.id)).toEqual(["c"]);
    expect(rankByQuery("Нарх руйхати", items).map((r) => r.id)).toEqual(["p5"]);
  });

  it("does not stem unrelated words", () => {
    expect(rankByQuery("telefon", [{ id: "t", text: "Televizor" }])).toEqual([]);
    expect(rankByQuery("mahsulot", [{ id: "m", text: "Mahalla" }])).toEqual([]);
    expect(rankByQuery("kurs", [{ id: "k", text: "Kurash" }])).toEqual([]);
  });

  it("exact beats prefix beats fuzzy, with a phrase bonus", () => {
    const ranked = rankByQuery("ingliz tili", items);
    expect(ranked[0]).toMatchObject({ id: "p1", score: 3 + 3 + 4 });
    expect(ranked[1]).toMatchObject({ id: "p2", score: 3 });
    const fuzzy = rankByQuery("devan", items);
    expect(fuzzy).toEqual([{ id: "p4", score: 1, index: 3 }]);
  });

  it("no fuzzy matching for short words", () => {
    expect(rankByQuery("rus", [{ id: "x", text: "rush" }]).map((r) => r.id)).toEqual(["x"]); // prefix
    expect(rankByQuery("rus", [{ id: "x", text: "bus" }])).toEqual([]);
  });

  it("is deterministic and respects the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, text: `Kurs ${i}` }));
    const a = rankByQuery("kurs", many, 5);
    const b = rankByQuery("kurs", many, 5);
    expect(a).toEqual(b);
    expect(a.map((r) => r.id)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(rankByQuery("kurs", many, 0)).toEqual([]);
  });

  it("returns nothing for an empty query; a stop-word-only query still tries", () => {
    expect(rankByQuery("", items)).toEqual([]);
    expect(rankByQuery("🙂", items)).toEqual([]);
    expect(rankByQuery("Нархи канча?", items).map((r) => r.id)).toEqual(["p5"]);
  });
});

describe("selectProductsV2 / selectFaqsV2", () => {
  const products = Array.from({ length: 20 }, (_, i) => ({
    name: i === 17 ? "Divan Milan" : i === 3 ? "Kreslo Oslo" : `Mahsulot ${i}`,
    note: i === 17 ? "3 o'rinli, kulrang" : null,
  }));

  it("returns everything when under the limit", () => {
    const few = products.slice(0, 5);
    expect(selectProductsV2("divan", few)).toEqual(few);
  });

  it("puts matching products first, then the rest in input order, up to the limit", () => {
    const picked = selectProductsV2("Диван борми? кулранг", products, 5);
    expect(picked).toHaveLength(5);
    expect(picked[0].name).toBe("Divan Milan");
    expect(picked.slice(1).map((p) => p.name)).toEqual(["Mahsulot 0", "Mahsulot 1", "Mahsulot 2", "Kreslo Oslo"]);
  });

  it("is stable across calls (P# ids do not shuffle)", () => {
    const a = selectProductsV2("кресло", products, 15);
    const b = selectProductsV2("кресло", products, 15);
    expect(a).toEqual(b);
    expect(a[0].name).toBe("Kreslo Oslo");
    expect(a).toHaveLength(15);
  });

  it("defaults to 15 products and 20 FAQs", () => {
    expect(selectProductsV2("x", products)).toHaveLength(15);
    const faqs = Array.from({ length: 25 }, (_, i) => ({
      question: i === 22 ? "Yetkazib berish bormi?" : `Savol ${i}`,
      answer: i === 22 ? "Ha, Toshkent bo'ylab bepul." : `Javob ${i}`,
    }));
    const picked = selectFaqsV2("Доставка етказиб берасизми?", faqs);
    expect(picked).toHaveLength(20);
    expect(picked[0].question).toBe("Yetkazib berish bormi?");
    expect(picked[1].question).toBe("Savol 0");
  });

  it("FAQ answers count too (Russian question, Latin answer)", () => {
    const faqs = Array.from({ length: 25 }, (_, i) => ({
      question: `Savol ${i}`,
      answer: i === 9 ? "Toshkent, Chilonzor 5" : `Javob ${i}`,
    }));
    expect(selectFaqsV2("Где вы находитесь? Ташкент?", faqs, 3)[0].answer).toBe("Toshkent, Chilonzor 5");
  });
});
