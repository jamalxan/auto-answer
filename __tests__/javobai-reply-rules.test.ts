import { describe, expect, it } from "vitest";
import { extractPhone } from "../lib/leads/phone";
import { sanitizeName, stripEmail } from "../lib/assistant/turn";
import { countQuestions, dropKnownFieldQuestions, limitToOneQuestion, stripQuestions } from "../lib/javobai/reply-rules";

describe("one question per message (B-10)", () => {
  it("trims to the first question, keeps statements", () => {
    const out = limitToOneQuestion("Milan divani bor. Qaysi rangni xohlaysiz? Byudjetingiz qancha? Rahmat.");
    expect(countQuestions(out)).toBe(1);
    expect(out).toContain("Qaysi rangni xohlaysiz?");
    expect(out).not.toContain("Byudjetingiz");
    expect(out).toContain("Rahmat.");
  });

  it("stripQuestions removes every question", () => {
    expect(stripQuestions("Ha, bor. Rangi qanday? Narxi kelishiladi.")).toBe("Ha, bor. Narxi kelishiladi.");
  });

  it("never re-asks a known budget / phone / name", () => {
    const reply = "Yaxshi tanlov. Taxminan qanday byudjetni mo'ljallayapsiz? Telefon raqamingizni qoldirasizmi?";
    expect(dropKnownFieldQuestions(reply, { budget: true })).toBe("Yaxshi tanlov. Telefon raqamingizni qoldirasizmi?");
    expect(dropKnownFieldQuestions(reply, { budget: true, phone: true })).toBe("Yaxshi tanlov.");
    expect(dropKnownFieldQuestions("Ismingiz nima?", { name: true })).toBe("");
    expect(dropKnownFieldQuestions("На какой бюджет примерно ориентируетесь?", { budget: true })).toBe("");
  });
});

describe("sentence splitting never corrupts tokens (H1)", () => {
  const keep = (t: string) => limitToOneQuestion(t);
  it.each([
    "Narxi 120.000 so'm.",
    "Link: https://socialauto.uz/p/1.5 ni oching.",
    "Narxi 2.5 mln so'm.",
    "Yozing: info@socialauto.uz yoki qo'ng'iroq qiling.",
    "Narxi 1,5 mln so'm turadi.",
    "Soat 9.30 da ochamiz.",
    "Hmm... ko'ramiz. Rahmat!",
    "Narxi 120.000 so'm. Qaysi rangni xohlaysiz? Byudjet qancha?",
  ])("keeps %s intact", (t) => {
    const out = keep(t);
    const expected = t.replace(/ Byudjet qancha\?$/, "");
    expect(out).toBe(expected);
    expect(stripQuestions(t)).toBe(t.replace(/ Qaysi rangni xohlaysiz\? Byudjet qancha\?$/, ""));
  });

  it("splits only on terminators followed by whitespace or end", () => {
    expect(countQuestions("Narxi 120.000 so'm? Rangi 1.5 mi? ok")).toBe(2);
    expect(countQuestions("https://x.uz/a?b=1 shu yerda")).toBe(0);
  });

  it("preserves the original whitespace when rejoining", () => {
    expect(stripQuestions("Ha.  Rangi qanday?  Narxi 2.5 mln.")).toBe("Ha.  Narxi 2.5 mln.");
  });
});

describe("known-field clause removal (H1)", () => {
  it("drops only the known clause of a compound sentence", () => {
    expect(dropKnownFieldQuestions("Telefon raqam bering, qaysi shaharda yashaysiz?", { phone: true })).toBe("Qaysi shaharda yashaysiz?");
  });
  it("keeps sentences that do not touch a known field and decimals", () => {
    expect(dropKnownFieldQuestions("Narxi 120.000 so'm. Telefon raqamingizni qoldirasizmi?", { phone: true })).toBe("Narxi 120.000 so'm.");
    expect(dropKnownFieldQuestions("Telefon raqam bering, qaysi shaharda yashaysiz?", {})).toBe("Telefon raqam bering, qaysi shaharda yashaysiz?");
  });
});

describe("lead capture fields (B-09)", () => {
  it("normalises the phone to +998XXXXXXXXX", () => {
    expect(extractPhone("Ali, 90 123 45 67")?.e164).toBe("+998901234567");
    expect(extractPhone("+998 (90) 123-45-67")?.e164).toBe("+998901234567");
  });

  it("an email is never a name; name and email stay separate", () => {
    expect(sanitizeName("ali@mail.com")).toBeNull();
    expect(sanitizeName("Ali ali@mail.com")).toBeNull();
    const rest = stripEmail("Ali ali@mail.com");
    expect(rest).toBe("Ali");
    expect(sanitizeName(rest)).toBe("Ali");
  });
});
