/**
 * ETAP 6 — flow variables: vocabulary, `{{...}}` rendering with fallbacks,
 * key extraction and validation.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  extractTemplateKeys,
  type FlowContext,
  isKnownVariable,
  parseTemplateRefs,
  renderTemplate,
  renderTemplateRecord,
  resolveVariable,
  stringifyValue,
  validateTemplateKeys,
  VARIABLE_SPECS,
  varsKey,
} from "../lib/flows/variables";

const ctx: FlowContext = {
  contact: { name: "Aziz", username: "aziz_uz", phone: "+998901234567", email: null },
  vars: { product: "Kurs", city: "Toshkent", empty: "" },
  trigger: { text: "Narxi qancha?", keyword: "narx", source: "ADS" },
  tags: ["hot", "ielts"],
  score: 72,
  window: { open: true },
  time: { hour: 14, weekday: 3 },
  run: { sends: 2 },
};

describe("vocabulary", () => {
  it("knows every spec key, vars.* and the shorthands", () => {
    for (const spec of VARIABLE_SPECS) expect(isKnownVariable(spec.key)).toBe(true);
    expect(isKnownVariable("vars.city")).toBe(true);
    expect(isKnownVariable("name")).toBe(true);
    expect(isKnownVariable("product")).toBe(true);
    expect(isKnownVariable("vars.Bad Key")).toBe(false);
    expect(isKnownVariable("contact.age")).toBe(false);
    expect(isKnownVariable("shahar")).toBe(false);
  });

  it("canonicalKey / varsKey", () => {
    expect(canonicalKey("name")).toBe("contact.name");
    expect(canonicalKey(" phone ")).toBe("contact.phone");
    expect(canonicalKey("product")).toBe("vars.product");
    expect(canonicalKey("vars.city")).toBe("vars.city");
    expect(varsKey("vars.city")).toBe("city");
    expect(varsKey("contact.name")).toBeNull();
    expect(varsKey("vars.")).toBeNull();
  });

  it("resolveVariable walks paths and shorthands", () => {
    expect(resolveVariable("contact.name", ctx)).toBe("Aziz");
    expect(resolveVariable("username", ctx)).toBe("aziz_uz");
    expect(resolveVariable("product", ctx)).toBe("Kurs");
    expect(resolveVariable("vars.city", ctx)).toBe("Toshkent");
    expect(resolveVariable("tags", ctx)).toEqual(["hot", "ielts"]);
    expect(resolveVariable("vars.missing", ctx)).toBeUndefined();
    expect(resolveVariable("contact.name.deep", ctx)).toBeUndefined();
    expect(resolveVariable("time.hour", {})).toBeUndefined();
  });

  it("stringifyValue", () => {
    expect(stringifyValue(null)).toBe("");
    expect(stringifyValue(["a", "b"])).toBe("a, b");
    expect(stringifyValue(true)).toBe("ha");
    expect(stringifyValue(false)).toBe("yo'q");
    expect(stringifyValue(12)).toBe("12");
    expect(stringifyValue(Number.NaN)).toBe("");
    expect(stringifyValue(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10-16T00:00:00.000Z");
    expect(stringifyValue({ a: 1 })).toBe("");
  });
});

describe("renderTemplate", () => {
  it("substitutes plain, nested and shorthand keys", () => {
    const { text, missing } = renderTemplate("Salom {{name}}! @{{username}} {{product}} {{vars.city}} {{trigger.keyword}} ball={{score}}", ctx);
    expect(text).toBe("Salom Aziz! @aziz_uz Kurs Toshkent narx ball=72");
    expect(missing).toEqual([]);
  });

  it("uses the fallback for empty / missing values and reports them", () => {
    const { text, missing } = renderTemplate("Salom {{name|do'stim}}, {{contact.email|email yo'q}}, {{vars.empty|bo'sh}}, {{vars.none}}.", ctx);
    expect(text).toBe("Salom Aziz, email yo'q, bo'sh, .");
    expect(missing).toEqual(["contact.email", "vars.empty", "vars.none"]);
  });

  it("tolerates spaces inside the braces and keeps fallback text with spaces", () => {
    expect(renderTemplate("{{ vars.price | menejer aytadi }}", ctx).text).toBe("menejer aytadi");
    expect(renderTemplate("{{ name }}", ctx).text).toBe("Aziz");
  });

  it("never leaves raw braces behind", () => {
    expect(renderTemplate("Salom {{name", ctx).text).toBe("Salom name");
    expect(renderTemplate("{{}} va {{ }}", ctx).text).toBe("va");
    expect(renderTemplate("{{vars.x|{{nested}}}}", ctx).text).not.toContain("{{");
    expect(renderTemplate("}} {{", ctx).text).toBe("");
  });

  it("renders lists and booleans in Uzbek", () => {
    expect(renderTemplate("Teglar: {{tags}}; oyna: {{window.open}}", ctx).text).toBe("Teglar: hot, ielts; oyna: ha");
  });

  it("renders a record of templates (webhook body)", () => {
    expect(renderTemplateRecord({ phone: "{{phone}}", city: "{{vars.city}}", none: "{{vars.none|-}}" }, ctx)).toEqual({ phone: "+998901234567", city: "Toshkent", none: "-" });
  });
});

describe("extractTemplateKeys / validateTemplateKeys", () => {
  it("extracts unique canonical keys in order", () => {
    expect(extractTemplateKeys("{{name}} {{vars.city|x}} {{name}} {{product}}")).toEqual(["contact.name", "vars.city", "vars.product"]);
    expect(parseTemplateRefs("{{name|do'stim}}")).toEqual([{ raw: "name", key: "contact.name", fallback: "do'stim" }]);
    expect(parseTemplateRefs("{{name}}")[0].fallback).toBeNull();
  });

  it("flags unknown keys and undeclared vars.*", () => {
    expect(validateTemplateKeys("{{name}} {{trigger.text}} {{vars.city}}", ["city"])).toEqual([]);
    expect(validateTemplateKeys("{{shahar}} {{vars.city}} {{contact.age}}", [])).toEqual(["shahar", "vars.city", "contact.age"]);
    expect(validateTemplateKeys("{{vars.Bad}}", ["Bad"])).toEqual(["vars.Bad"]);
    expect(validateTemplateKeys("{{}}", [])).toEqual([""]);
  });
});
