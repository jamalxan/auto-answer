/**
 * T4 — FAQ chips (prices / address / hours) with JavobAI takeover for
 * everything else and an operator fallback when JavobAI is not LIVE.
 */

import type { FlowStarterTemplateInput } from "./types";

export const T4_FAQ_JAVOBAI: FlowStarterTemplateInput = {
  key: "faq_javobai",
  name: "FAQ + JavobAI",
  description: "Yangi mijozga ko'p so'raladigan savollar tugmalari; boshqa savollarga JavobAI javob beradi, u LIVE bo'lmasa operator.",
  triggerType: "DIRECT_MESSAGE",
  category: "faq",
  tags: [],
  graph: {
    v: 1,
    variables: [
      { key: "brand", label: "Brend nomi", kind: "string" },
      { key: "prices", label: "Narxlar matni", kind: "string" },
      { key: "address", label: "Manzil", kind: "string" },
      { key: "hours", label: "Ish vaqti", kind: "string" },
    ],
    nodes: [
      { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY", audience: "NEW_CONTACT", cooldownHours: 24 },
      { id: "m1", type: "message", text: "Salom, {{name|do'stim}}! Men {{vars.brand|do'konimiz}} yordamchisiman. Savolingizni yozing yoki tanlang 👇" },
      {
        id: "b1",
        type: "button",
        text: "Ko'p so'raladigan savollar:",
        buttons: [
          { id: "price", label: "Narxlar" },
          { id: "addr", label: "Manzil" },
          { id: "time", label: "Ish vaqti" },
          { id: "ai", label: "Boshqa savol" },
        ],
      },
      { id: "mp", type: "message", text: "Narxlar: {{vars.prices|menejer yozadi}}" },
      { id: "ma", type: "message", text: "Manzil: {{vars.address|menejer yozadi}}" },
      { id: "mt", type: "message", text: "Ish vaqti: {{vars.hours|9:00–18:00}}" },
      { id: "ai", type: "ai", mode: "takeover", intro: "Savolingizga JavobAI javob beradi 🤖" },
      { id: "op", type: "operator", reply: "Menejerimiz tez orada javob beradi.", reason: "flow_rule" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "b1", handle: "next" },
      { from: "b1", to: "mp", handle: "tap:price" },
      { from: "b1", to: "ma", handle: "tap:addr" },
      { from: "b1", to: "mt", handle: "tap:time" },
      { from: "b1", to: "ai", handle: "tap:ai" },
      { from: "b1", to: "ai", handle: "other" },
      { from: "mp", to: "end", handle: "next" },
      { from: "ma", to: "end", handle: "next" },
      { from: "mt", to: "end", handle: "next" },
      { from: "ai", to: "op", handle: "fallback" },
    ],
  },
};
