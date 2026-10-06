import { describe, expect, it } from "vitest";
import {
  extractPhone,
  looksLikeBrokenPhone,
  parsePhone,
  stripPhone,
} from "../lib/leads/phone";

describe("parsePhone — Uzbek formats", () => {
  const valid = [
    "+998901234567",
    "998901234567",
    "901234567",
    "90 123 45 67",
    "90-123-45-67",
    "(90) 123-45-67",
    "+998 90 123 45 67",
    "+998(90)123-45-67",
    "90.123.45.67",
    "  +998901234567  ",
    "998 90 123 45 67",
    "+99890-123-45-67",
  ];
  it.each(valid)("accepts %s", (input) => {
    expect(parsePhone(input)?.e164).toBe("+998901234567");
  });

  it("accepts other Uzbek operator codes", () => {
    expect(parsePhone("33 123 45 67")?.e164).toBe("+998331234567");
    expect(parsePhone("+998 77 123 45 67")?.e164).toBe("+998771234567");
    expect(parsePhone("88 123 45 67")?.e164).toBe("+998881234567");
  });
});

describe("parsePhone — rejects", () => {
  const invalid = [
    "",
    "abc",
    "12345",
    "90 123 45",
    "+998 90 123 45",
    "1234567890123456",
    "000000000",
    "+998000000000",
    "доксон бир икки уч",
  ];
  it.each(invalid)("rejects %j", (input) => {
    expect(parsePhone(input)).toBeNull();
  });
});

describe("parsePhone — foreign numbers", () => {
  it("accepts a valid Russian number", () => {
    expect(parsePhone("+7 912 345 67 89")?.e164).toBe("+79123456789");
  });
  it("accepts a valid Turkish number", () => {
    expect(parsePhone("+90 532 123 45 67")?.e164).toBe("+905321234567");
  });
  it("rejects an invalid foreign number", () => {
    expect(parsePhone("+7 000 000 00 00")).toBeNull();
  });
});

describe("extractPhone — from free text", () => {
  it("finds a number after the name", () => {
    expect(extractPhone("Aziz 901234567")?.e164).toBe("+998901234567");
  });
  it("finds a spaced number inside a sentence", () => {
    expect(extractPhone("Mening raqamim 90 123 45 67, qo'ng'iroq qiling")?.e164).toBe(
      "+998901234567"
    );
  });
  it("finds a +998 number inside a sentence", () => {
    expect(extractPhone("yozing +998901234567 ga")?.e164).toBe("+998901234567");
  });
  it("returns null when there is no number", () => {
    expect(extractPhone("Salom, divan bormi?")).toBeNull();
  });
  it("does not accept a number written in words", () => {
    expect(extractPhone("тўқсон бир икки уч тўрт беш олти етти")).toBeNull();
  });
  it("ignores numbers that are not phones (price, quantity)", () => {
    expect(extractPhone("2 ta divan kerak, 4500000 so'm")).toBeNull();
  });
  it("returns null for empty text", () => {
    expect(extractPhone("")).toBeNull();
  });
});

describe("looksLikeBrokenPhone", () => {
  it("flags an incomplete number", () => {
    expect(looksLikeBrokenPhone("90 123 4")).toBe(true);
  });
  it("does not flag text with a valid number", () => {
    expect(looksLikeBrokenPhone("901234567")).toBe(false);
  });
  it("does not flag plain text", () => {
    expect(looksLikeBrokenPhone("salom")).toBe(false);
  });
});

describe("stripPhone", () => {
  it("leaves the name", () => {
    expect(stripPhone("Aziz, 90 123 45 67")).toBe("Aziz");
  });
  it("handles a leading number", () => {
    expect(stripPhone("901234567 Aziz")).toBe("Aziz");
  });
});
