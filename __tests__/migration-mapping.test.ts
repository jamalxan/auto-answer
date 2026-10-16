/**
 * ETAP 11 — pure mapping rules: tag slugs and collisions, custom field keys,
 * bot field variable keys, the checklist.
 */

import { describe, expect, it } from "vitest";
import { buildChecklist, CONTACT_MIGRATION_GUIDANCE, mapBotFields, mapCustomField, mapCustomFields, mapTags, slugifyTag, toVariableKey, VAR_KEY_PATTERN } from "../lib/migration/mapping";

describe("tags", () => {
  it("slugifies like the CRM and never returns an empty slug", () => {
    expect(slugifyTag("Hot Lead!")).toBe("hot-lead");
    expect(slugifyTag("Москва")).toMatch(/^[a-z0-9-]+$/);
    expect(slugifyTag("!!!")).toBe("teg");
  });

  it("create / merge with existing slugs / merge on collisions inside the batch / skip empty", () => {
    const mapped = mapTags(
      [
        { id: "1", name: "VIP" },
        { id: "2", name: "vip" },
        { id: "3", name: "Yangi mijoz" },
        { id: "4", name: "Hot" },
        { id: "5", name: "???" },
      ],
      ["hot"]
    );
    expect(mapped.map((m) => [m.targetSlug, m.action])).toEqual([
      ["vip", "create"],
      ["vip", "merge"],
      ["yangi-mijoz", "create"],
      ["hot", "merge"],
      ["", "skip"],
    ]);
    expect(mapped[0].sourceId).toBe("1");
  });
});

describe("custom fields", () => {
  it("makes snake_case keys with types and notes", () => {
    expect(mapCustomField({ name: "Telefon raqami", type: "text" })).toMatchObject({ key: "telefon_raqami", type: "string" });
    expect(mapCustomField({ name: "Yosh", type: "number" }).type).toBe("number");
    expect(mapCustomField({ name: "VIP?", type: "boolean" }).type).toBe("boolean");
    expect(mapCustomField({ name: "Tug'ilgan kun", type: "date" })).toMatchObject({ type: "date" });
    expect(mapCustomField({ name: "Manzillar", type: "array" }).type).toBe("list");
    expect(mapCustomField({ name: "x", type: "weird" }).type).toBe("string");
    expect(mapCustomField({ name: "Номер телефона", type: "text" }).key).toMatch(VAR_KEY_PATTERN);
  });

  it("keys always match the flow variable rule and stay collision-free", () => {
    for (const name of ["123 abc", "   ", "!!!", "A".repeat(80), "Телефон / Phone", "ğüş"]) {
      expect(toVariableKey(name)).toMatch(VAR_KEY_PATTERN);
    }
    const mapped = mapCustomFields([
      { id: "1", name: "Phone", type: "text", description: null },
      { id: "2", name: "phone", type: "text", description: null },
      { id: "3", name: "PHONE!", type: "number", description: null },
    ]);
    expect(new Set(mapped.map((m) => m.key)).size).toBe(3);
    expect(mapped.map((m) => m.key)).toEqual(["phone", "phone_2", "phone_3"]);
    expect(mapCustomFields([{ id: "1", name: "Phone", type: "text", description: null }], ["phone"])[0].key).toBe("phone_2");
  });

  it("long colliding keys keep within 32 characters", () => {
    const long = "A".repeat(40);
    const keys = mapCustomFields([1, 2, 3].map((n) => ({ id: String(n), name: long, type: "text", description: null }))).map((m) => m.key);
    for (const key of keys) expect(key).toMatch(VAR_KEY_PATTERN);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("bot fields", () => {
  it("variable keys are valid and unique, values are cleaned and capped", () => {
    const mapped = mapBotFields(
      [
        { id: "1", name: "Manzil", type: "text", value: "Toshkent, Chilonzor" },
        { id: "2", name: "manzil", type: "text", value: "{{x}} yana" },
        { id: "3", name: "1-narx", type: "number", value: "120000" },
        { id: "4", name: "Bo'sh", type: "text", value: null },
        { id: "5", name: "Uzun", type: "text", value: "z".repeat(900) },
      ],
      ["telefon"]
    );
    for (const m of mapped) expect(m.varKey).toMatch(VAR_KEY_PATTERN);
    expect(new Set(mapped.map((m) => m.varKey)).size).toBe(mapped.length);
    expect(mapped[1].value).toBe("x yana");
    expect(mapped[3]).toMatchObject({ value: "", hasValue: false });
    expect(mapped[4].value.length).toBe(500);
  });
});

describe("checklist", () => {
  it("lists manual steps as todo and finished imports as done", () => {
    const items = [
      { kind: "TAG", status: "IMPORTED" },
      { kind: "TAG", status: "PENDING" },
      { kind: "CUSTOM_FIELD", status: "IMPORTED" },
      { kind: "BOT_FIELD", status: "PENDING" },
      { kind: "FLOW", status: "PENDING" },
      { kind: "FLOW", status: "MAPPED" },
      { kind: "FLOW", status: "CONVERTED" },
      { kind: "FLOW", status: "IMPORTED" },
      { kind: "GROWTH_TOOL", status: "PENDING" },
    ];
    const { done, todo } = buildChecklist({ instagramAccountId: null, items });
    expect(done.join("\n")).toMatch(/1 ta teg CRM/);
    expect(done.join("\n")).toMatch(/1 ta oqim qoralama/);
    const text = todo.join("\n");
    expect(text).toMatch(/ig\.me/);
    expect(text).toMatch(/Growth Tool/);
    expect(text).toMatch(/Comment 2\.0/);
    expect(text).toMatch(/Instagram akkaunt/);
    expect(text).toMatch(/24 soatlik/);
    expect(text).toMatch(/skrinshot/);
  });

  it("drops the account step once an account is chosen; guidance explains re-opt-in", () => {
    expect(buildChecklist({ instagramAccountId: "a1", items: [] }).todo.join("\n")).not.toMatch(/Instagram akkauntni ulang/);
    expect(CONTACT_MIGRATION_GUIDANCE).toMatch(/ig\.me/);
    expect(CONTACT_MIGRATION_GUIDANCE).toMatch(/24 soat/);
  });
});
