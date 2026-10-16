/**
 * T3 — ad message (Click-to-Direct) → qualification (need, city) → phone →
 * lead → CRM deal → tag.
 */

import type { FlowStarterTemplateInput } from "./types";

export const T3_AD_QUALIFICATION: FlowStarterTemplateInput = {
  key: "ad_qualify_crm",
  name: "Reklama xabari → saralash → CRM",
  description: "Reklamadan kelgan xabarga ehtiyoj va shahar so'raladi, Toshkentdagilardan raqam olinadi, lead CRM'ga bitim bo'lib tushadi.",
  triggerType: "DIRECT_MESSAGE",
  category: "ads",
  tags: ["reklama"],
  graph: {
    v: 1,
    variables: [
      { key: "need", label: "Ehtiyoj", kind: "string" },
      { key: "city", label: "Shahar", kind: "string" },
      { key: "phone", label: "Telefon", kind: "phone" },
    ],
    nodes: [
      { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY", sourceFilter: "ADS", cooldownHours: 24 },
      { id: "m1", type: "message", text: "Salom! Reklamadan kelganingiz uchun rahmat 🙌 Sizga qaysi biri kerak?" },
      {
        id: "b1",
        type: "button",
        text: "Tanlang:",
        buttons: [
          { id: "a", label: "Mahsulot A", saveAs: "need" },
          { id: "b", label: "Mahsulot B", saveAs: "need" },
          { id: "c", label: "Boshqa", saveAs: "need" },
        ],
      },
      {
        id: "ai1",
        type: "ai",
        mode: "ask",
        question: "Qaysi shahardasiz?",
        saveAs: "city",
        extract: "city",
        retries: 1,
        retryText: "Shahar nomini yozing, iltimos",
      },
      {
        id: "c1",
        type: "condition",
        branches: [{ id: "tosh", label: "Toshkent", when: { v: 1, all: [{ field: "vars.city", op: "contains", value: "toshkent" }] } }],
      },
      {
        id: "b2",
        type: "button",
        text: "Raqamingizni qoldiring, menejer bugun bog'lanadi:",
        buttons: [
          { id: "ph", label: "Raqamni yuborish", kind: "phone", saveAs: "phone" },
          { id: "no", label: "Keyinroq" },
        ],
      },
      { id: "m2", type: "message", text: "Hozircha faqat Toshkentda xizmat ko'rsatamiz, lekin raqamingizni qoldiring — kengayganda xabar beramiz." },
      { id: "lead", type: "lead", phoneFrom: "vars.phone", summary: "Reklama: {{vars.need|?}}, {{vars.city|?}}", thanks: "Rahmat! Menejer bugun bog'lanadi." },
      { id: "crm", type: "crm", action: "create_deal" },
      { id: "tag", type: "tag", action: "add", tagSlugs: ["reklama"] },
      { id: "bye", type: "message", text: "Yaxshi, savol bo'lsa shu yerga yozing 🙂" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "b1", handle: "next" },
      { from: "b1", to: "ai1", handle: "tap:a" },
      { from: "b1", to: "ai1", handle: "tap:b" },
      { from: "b1", to: "ai1", handle: "tap:c" },
      { from: "b1", to: "ai1", handle: "other" },
      { from: "ai1", to: "c1", handle: "next" },
      { from: "ai1", to: "b2", handle: "missing" },
      { from: "c1", to: "b2", handle: "branch:tosh" },
      { from: "c1", to: "m2", handle: "else" },
      { from: "m2", to: "b2", handle: "next" },
      { from: "b2", to: "lead", handle: "tap:ph" },
      { from: "b2", to: "bye", handle: "tap:no" },
      { from: "b2", to: "bye", handle: "other" },
      { from: "bye", to: "end", handle: "next" },
      { from: "lead", to: "crm", handle: "next" },
      { from: "lead", to: "bye", handle: "missing" },
      { from: "crm", to: "tag", handle: "next" },
      { from: "tag", to: "end", handle: "next" },
    ],
  },
};
