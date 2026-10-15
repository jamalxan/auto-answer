/**
 * Comment Automation 2.0 — normaliser, intents, campaign priority (TZ 8.1 /
 * 8.2) and reply variants (TZ 9). Pure: no database.
 */

import { describe, expect, it } from "vitest";
import {
  BUILT_IN_INTENTS,
  containsWords,
  findIntent,
  findKeyword,
  normalizeForMatch,
} from "../lib/triggers/keywords";
import {
  evaluateCommentCampaign,
  selectCommentCampaign,
  type CommentMatchableCampaign,
} from "../lib/triggers/matching";
import { pickVariant, usableVariants, type PickableVariant } from "../lib/triggers/variants";

describe("normalizeForMatch", () => {
  it("lowercases, strips punctuation and emoji, collapses spaces", () => {
    expect(normalizeForMatch("  Narxi??  🔥🔥 qancha!!! ")).toBe("narxi qancha");
  });

  it("unifies every Uzbek apostrophe form", () => {
    const forms = ["to‘lov", "to'lov", "toʻlov", "to`lov", "to’lov", "TOʼLOV"];
    for (const form of forms) expect(normalizeForMatch(form), form).toBe("tolov");
    expect(normalizeForMatch("g‘isht")).toBe(normalizeForMatch("g'isht"));
  });

  it("transliterates Uzbek Cyrillic to the Latin spelling", () => {
    expect(normalizeForMatch("НАРХИ қанча?")).toBe("narxi qancha");
    expect(normalizeForMatch("Ўзбекистон")).toBe(normalizeForMatch("O‘zbekiston"));
    expect(normalizeForMatch("ғишт")).toBe(normalizeForMatch("g'isht"));
    expect(normalizeForMatch("ҳа")).toBe("ha");
    expect(normalizeForMatch("шахар чегара")).toBe("shaxar chegara");
    expect(normalizeForMatch("маълумот")).toBe(normalizeForMatch("ma'lumot"));
  });

  it("applies the е / ё / ю / я rules", () => {
    expect(normalizeForMatch("етказиб")).toBe("yetkazib");
    expect(normalizeForMatch("келди")).toBe("keldi");
    expect(normalizeForMatch("ёқди")).toBe("yoqdi");
    expect(normalizeForMatch("юбор")).toBe("yubor");
    expect(normalizeForMatch("янги")).toBe("yangi");
  });

  it("transliterates Russian the same way", () => {
    expect(normalizeForMatch("Цена?")).toBe("tsena");
    expect(normalizeForMatch("Сколько стоит")).toBe("skolko stoit");
  });
});

describe("keywords", () => {
  it("EXACT needs the whole comment; CONTAINS needs whole words", () => {
    expect(findKeyword("Narx!", ["narx"], "EXACT")).toBe("narx");
    expect(findKeyword("narxi", ["narx"], "EXACT")).toBeNull();
    expect(findKeyword("Salom, narx qancha?", ["narx qancha"], "CONTAINS")).toBe("narx qancha");
    expect(findKeyword("konkurs", ["kurs"], "CONTAINS")).toBeNull();
    expect(findKeyword("Kurs bormi", ["kurs"], "CONTAINS")).toBe("kurs");
  });

  it("matches a keyword across scripts", () => {
    expect(findKeyword("НАРХ", ["narx"], "EXACT")).toBe("narx");
    expect(findKeyword("narx", ["нарх"], "EXACT")).toBe("нарх");
  });

  it("containsWords never matches inside a word", () => {
    expect(containsWords("abc narxi", "narx")).toBe(false);
    expect(containsWords("abc narx", "narx")).toBe(true);
  });
});

describe("built-in intents", () => {
  it("exposes the seven intents with labels and examples", () => {
    expect(BUILT_IN_INTENTS.map((i) => i.key)).toEqual([
      "PRICE", "ADDRESS", "CATALOG", "ORDER", "DELIVERY", "CONTACT", "INFO",
    ]);
    for (const intent of BUILT_IN_INTENTS) {
      expect(intent.label.length).toBeGreaterThan(0);
      expect(intent.examples.length).toBeGreaterThan(5);
    }
  });

  it.each([
    ["НАРХИ қанча?", "PRICE"],
    ["Цена?", "PRICE"],
    ["narhi qancha", "PRICE"],
    ["Сколько стоит?", "PRICE"],
    ["Манзил қаерда?", "ADDRESS"],
    ["Где вы находитесь?", "ADDRESS"],
    ["Dostavka bormi?", "DELIVERY"],
    ["Етказиб берасизми?", "DELIVERY"],
    ["zakaz qilmoqchiman", "ORDER"],
    ["Ma’lumot bering", "INFO"],
    ["Katalog bormi", "CATALOG"],
    ["telefon raqamingiz", "CONTACT"],
  ])("%s → %s", (text, intent) => {
    const all = BUILT_IN_INTENTS.map((i) => i.key);
    expect(findIntent(text, [intent])?.intent).toBe(intent);
    expect(findIntent(text, all)).not.toBeNull();
  });

  it("only checks the intents the campaign selected", () => {
    expect(findIntent("Цена?", ["ADDRESS"])).toBeNull();
    expect(findIntent("salom", ["PRICE"])).toBeNull();
  });
});

let n = 0;
function campaign(overrides: Partial<CommentMatchableCampaign> = {}): CommentMatchableCampaign {
  n++;
  return {
    id: `c${n}`,
    triggerType: "COMMENT",
    active: true,
    mediaScope: "ANY",
    mediaIds: [],
    keywords: [],
    matchingMode: "EVERY",
    intents: [],
    priority: 0,
    createdAt: new Date(2026, 0, n),
    ...overrides,
  };
}

describe("selectCommentCampaign — TZ 8.2 priority", () => {
  const input = { mediaId: "post1", text: "narx" };

  it("EXACT keyword beats CONTAINS beats INTENT beats EVERY", () => {
    const every = campaign({ matchingMode: "EVERY", priority: 50 });
    const intent = campaign({ matchingMode: "CONTAINS", keywords: ["zzz"], intents: ["PRICE"], priority: 40 });
    const contains = campaign({ matchingMode: "CONTAINS", keywords: ["narx"], priority: 30 });
    const exact = campaign({ matchingMode: "EXACT", keywords: ["narx"] });

    expect(selectCommentCampaign([every, intent, contains, exact], input)).toMatchObject({
      campaign: exact,
      matchKind: "EXACT",
      matchedKeyword: "narx",
    });
    expect(selectCommentCampaign([every, intent, contains], input).matchKind).toBe("CONTAINS");
    expect(selectCommentCampaign([every, intent], input)).toMatchObject({ matchKind: "INTENT", intent: "PRICE" });
    expect(selectCommentCampaign([every], input).matchKind).toBe("EVERY");
  });

  it("a campaign for this post beats an any-post one of the same kind", () => {
    const any = campaign({ matchingMode: "CONTAINS", keywords: ["narx"], priority: 99 });
    const specific = campaign({ matchingMode: "CONTAINS", keywords: ["narx"], mediaScope: "SPECIFIC", mediaIds: ["post1"] });
    expect(selectCommentCampaign([any, specific], input).campaign).toBe(specific);
  });

  it("then higher priority, then the oldest", () => {
    const old = campaign({ matchingMode: "CONTAINS", keywords: ["narx"] });
    const young = campaign({ matchingMode: "CONTAINS", keywords: ["narx"] });
    const important = campaign({ matchingMode: "CONTAINS", keywords: ["narx"], priority: 5 });
    expect(selectCommentCampaign([young, old], input).campaign).toBe(old);
    expect(selectCommentCampaign([young, old, important], input).campaign).toBe(important);
  });

  it("SPECIFIC scope needs the post (or the ad's original post)", () => {
    const specific = campaign({ mediaScope: "SPECIFIC", mediaIds: ["post9"] });
    expect(evaluateCommentCampaign(specific, input)).toEqual({ matched: false, reason: "media_scope" });
    expect(evaluateCommentCampaign(specific, { ...input, altMediaId: "post9" }).matched).toBe(true);
    expect(selectCommentCampaign([specific], input).ignoredReason).toBe("Bu post uchun kampaniya sozlanmagan");
  });

  it("explains why nothing matched", () => {
    expect(selectCommentCampaign([], input).ignoredReason).toBe("Izohlar uchun faol kampaniya yo'q");
    expect(selectCommentCampaign([campaign({ active: false })], input).campaign).toBeNull();
    expect(selectCommentCampaign([campaign({ triggerType: "STORY_REPLY" })], input).campaign).toBeNull();
    expect(
      selectCommentCampaign([campaign({ matchingMode: "CONTAINS", keywords: ["kurs"] })], input).ignoredReason
    ).toBe("Kalit so'z yoki intent mos kelmadi");
    expect(evaluateCommentCampaign(campaign({ matchingMode: "CONTAINS" }), input)).toEqual({
      matched: false,
      reason: "no_condition",
    });
  });

  it("ignores unknown intent keys", () => {
    expect(evaluateCommentCampaign(campaign({ matchingMode: "CONTAINS", intents: ["NOPE"] }), input).matched).toBe(false);
  });
});

describe("pickVariant", () => {
  const v = (id: string, overrides: Partial<PickableVariant> = {}): PickableVariant => ({
    id,
    kind: "DM",
    text: `text ${id}`,
    weight: 1,
    sort: Number(id.replace(/\D/g, "")) || 0,
    approvedAt: new Date(),
    ...overrides,
  });

  it("uses only approved, non-empty variants of the kind", () => {
    const list = [v("v1"), v("v2", { approvedAt: null }), v("v3", { text: "  " }), v("v4", { kind: "PUBLIC" })];
    expect(usableVariants(list, "DM").map((x) => x.id)).toEqual(["v1"]);
    expect(usableVariants(list, "PUBLIC").map((x) => x.id)).toEqual(["v4"]);
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickVariant([], "RANDOM", 0)).toBeNull();
  });

  it("SEQUENTIAL walks the list and wraps", () => {
    const list = [v("v1"), v("v2"), v("v3")];
    expect([0, 1, 2, 3, 4, -1].map((c) => pickVariant(list, "SEQUENTIAL", c)!.id)).toEqual([
      "v1", "v2", "v3", "v1", "v2", "v3",
    ]);
  });

  it("RANDOM follows the rng", () => {
    const list = [v("v1"), v("v2"), v("v3")];
    expect(pickVariant(list, "RANDOM", 0, () => 0)!.id).toBe("v1");
    expect(pickVariant(list, "RANDOM", 0, () => 0.99)!.id).toBe("v3");
  });

  it("WEIGHTED follows the weights (seeded rng)", () => {
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const list = [v("v1", { weight: 1 }), v("v2", { weight: 3 }), v("v3", { weight: 0 })];
    const counts: Record<string, number> = { v1: 0, v2: 0, v3: 0 };
    for (let i = 0; i < 4000; i++) counts[pickVariant(list, "WEIGHTED", 0, rng)!.id]++;
    expect(counts.v3).toBe(0);
    expect(counts.v2 / counts.v1).toBeGreaterThan(2.5);
    expect(counts.v2 / counts.v1).toBeLessThan(3.5);
  });

  it("WEIGHTED with all-zero weights falls back to uniform", () => {
    const list = [v("v1", { weight: 0 }), v("v2", { weight: 0 })];
    expect(pickVariant(list, "WEIGHTED", 0, () => 0.75)!.id).toBe("v2");
  });
});
