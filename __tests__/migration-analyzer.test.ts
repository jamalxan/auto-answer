/**
 * ETAP 11 — the pure analyser and the feature catalogue on realistic uz / ru /
 * en ManyChat flow descriptions.
 */

import { describe, expect, it } from "vitest";
import { analyzeFlowText, detectLanguage, extractKeywords, suggestTriggerType } from "../lib/migration/analyzer";
import { catalogEntry, FEATURE_CATALOG } from "../lib/migration/catalog";

const UZ = `
Trigger: Instagram Comments growth tool, kalit so'z "narx" yoki "price".
1. Xabar yuborish: "Salom {{first_name}}! Narxni yuboraymi?" Tugma: "Ha, yuboring".
2. 10 daqiqa kutish (Smart Delay).
3. VIP teg qo'shish.
4. Agar mijoz tegi VIP bo'lsa, chegirma xabari; aks holda oddiy xabar.
5. Adminga xabar yuborish.
6. Telefon raqamini so'rash.
`;

const RU = `
Триггер: комментарии в Instagram, ключевое слово «цена».
Отправить сообщение: "Привет, {{first_name}}!" Кнопки: "Да", "Нет".
Задержка 5 минут. Добавить тег "lead". Условие: если у пользователя тег VIP.
Перейти к другому flow. Оплата через Stripe. Отправить в WhatsApp.
`;

const EN = `
Trigger: Story Mention. Send Message "Thanks for the mention!" with Quick Reply buttons.
Smart Delay: wait until 9:00 time of day. Add Tag "story". Zapier external request to our CRM.
Subscribe to sequence "Welcome". Send email. Facebook Messenger channel. Live Chat takeover.
`;

describe("analyzeFlowText", () => {
  it("reads an Uzbek comment-keyword flow", () => {
    const a = analyzeFlowText(UZ);
    expect(a.language).toBe("uz");
    expect(a.triggers.map((t) => t.kind)).toEqual(expect.arrayContaining(["trigger_comment", "trigger_keyword"]));
    expect(a.triggers.find((t) => t.kind === "trigger_keyword")?.detail).toContain("narx");
    const kinds = a.nodes.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["send_message", "quick_reply", "smart_delay", "tag_add", "condition", "notify_admin"]));
    expect(a.unsupported.map((f) => f.feature)).not.toContain("payment");
    expect(suggestTriggerType(a)).toBe("COMMENT");
    expect(a.notes.some((n) => n.code === "comment_window")).toBe(true);
  });

  it("flags unsupported features in Russian: payment, WhatsApp, go to flow", () => {
    const a = analyzeFlowText(RU);
    expect(a.language).toBe("ru");
    const features = a.unsupported.map((f) => f.feature);
    expect(features).toEqual(expect.arrayContaining(["payment", "channel_whatsapp", "go_to_flow"]));
    expect(a.unsupported.find((f) => f.feature === "payment")?.severity).toBe("error");
    expect(a.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(["smart_delay", "tag_add", "quick_reply", "condition"]));
  });

  it("flags Zapier, sequences, time-of-day delay, email and Messenger in English; live chat is supported", () => {
    const a = analyzeFlowText(EN);
    expect(a.language).toBe("en");
    expect(a.triggers.map((t) => t.kind)).toContain("trigger_story_mention");
    const features = a.unsupported.map((f) => f.feature);
    expect(features).toEqual(expect.arrayContaining(["zapier_make", "sequence", "smart_delay_time_of_day", "send_email", "channel_messenger", "external_request"]));
    expect(features).not.toContain("live_chat");
    expect(a.nodes.map((n) => n.kind)).toContain("live_chat");
    expect(suggestTriggerType(a)).toBe("STORY_MENTION");
  });

  it("every finding has an Uzbek message and a suggestion", () => {
    for (const f of analyzeFlowText(`${RU}\n${EN}`).unsupported) {
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.suggestion?.length ?? 0).toBeGreaterThan(5);
    }
  });

  it("warns when no trigger is recognised, and counts repeated nodes", () => {
    const a = analyzeFlowText("Send message hello. Send message again. Then delay 5 minutes.");
    expect(a.notes.some((n) => n.code === "no_trigger")).toBe(true);
    expect(a.nodes.find((n) => n.kind === "send_message")?.count).toBeGreaterThanOrEqual(2);
    expect(suggestTriggerType(a)).toBeUndefined();
  });

  it("is pure and safe on empty input", () => {
    expect(analyzeFlowText("")).toMatchObject({ triggers: [], nodes: [], unsupported: [], notes: [] });
    expect(analyzeFlowText(UZ)).toEqual(analyzeFlowText(UZ));
  });

  it("Story reply is partial (separate module) and Default reply maps to a Direct trigger", () => {
    const a = analyzeFlowText("Trigger: Story reply. Default Reply fallback.");
    expect(a.unsupported.find((f) => f.feature === "trigger_story_reply")?.severity).toBe("warning");
    expect(a.triggers.map((t) => t.kind)).toContain("trigger_default_reply");
  });

  it("normalises Uzbek apostrophe variants", () => {
    const a = analyzeFlowText("Kalit soʻz: “narx”. Teg qoʻshish.");
    expect(a.triggers.map((t) => t.kind)).toContain("trigger_keyword");
    expect(a.nodes.map((n) => n.kind)).toContain("tag_add");
  });
});

describe("helpers", () => {
  it("extractKeywords reads quoted words on keyword lines only", () => {
    expect(extractKeywords(`Kalit so'z: "narx", «price»\nXabar: "Salom"`)).toEqual(["narx", "price"]);
  });

  it("detectLanguage separates uz / ru / en and reports mixes", () => {
    expect(detectLanguage("Salom, xabar yuboring va tugma qo'shing")).toBe("uz");
    expect(detectLanguage("Привет, отправить сообщение клиенту, если кнопка")).toBe("ru");
    expect(detectLanguage("When the user clicks the button, send the message")).toBe("en");
    expect(detectLanguage("Salom xabar yuboring. Отправить сообщение. Send the message when the user clicks.")).toBe("mixed");
  });
});

describe("feature catalogue", () => {
  it("every entry has a unique key, patterns, an Uzbek message and a suggestion", () => {
    const keys = new Set<string>();
    for (const entry of FEATURE_CATALOG) {
      expect(keys.has(entry.key)).toBe(false);
      keys.add(entry.key);
      expect(entry.patterns.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(2);
      expect(entry.message.length).toBeGreaterThan(10);
      expect(entry.suggestion.length).toBeGreaterThan(5);
      expect(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]).toContain(entry.status);
      for (const p of entry.patterns) expect(p.flags).toContain("g");
    }
  });

  it("contains the required unsupported and partial features", () => {
    for (const key of ["channel_messenger", "channel_whatsapp", "channel_telegram", "channel_sms", "payment", "sequence", "smart_delay_time_of_day", "broadcast", "ice_breakers", "ai_step"]) {
      expect(catalogEntry(key)?.status).toBe("UNSUPPORTED");
    }
    for (const key of ["user_input", "gallery", "external_request"]) expect(catalogEntry(key)?.status).toBe("PARTIAL");
    expect(catalogEntry("ai_step")?.maps_to).toMatch(/ai/);
  });
});
