/**
 * T1 — comment "narx" → private reply with the opening button → price →
 * catalog / phone → lead → tag → Telegram. The classic Uzbek-market flow
 * (TZ 64 scenario A).
 */

import type { FlowStarterTemplateInput } from "./types";

export const T1_COMMENT_PRICE_LEAD: FlowStarterTemplateInput = {
  key: "comment_price_lead",
  name: "Komment: narx → katalog → telefon → lead",
  description:
    "Post ostida narx so'ragan odamga Direct'da tugmali javob, narx va katalog, keyin telefon raqami so'raladi; raqam Lead bo'lib Telegram'ga tushadi.",
  triggerType: "COMMENT",
  category: "sales",
  tags: ["lead", "narx"],
  graph: {
    v: 1,
    variables: [
      { key: "phone", label: "Telefon", kind: "phone" },
      { key: "product", label: "Mahsulot nomi", kind: "string" },
      { key: "price", label: "Narx", kind: "string" },
      { key: "catalog_url", label: "Katalog havolasi", kind: "string" },
    ],
    nodes: [
      {
        id: "t",
        type: "trigger",
        triggerType: "COMMENT",
        matchingMode: "CONTAINS",
        keywords: ["narx", "narxi", "price", "цена"],
        intents: ["PRICE"],
        publicReply: "Narxni Direct'ga yubordik 📩",
      },
      {
        id: "m1",
        type: "message",
        text: "Salom {{name|do'stim}}! Narxlar bilan tanishish uchun tugmani bosing 👇",
        button: { id: "open", label: "Narxni ko'rish" },
      },
      { id: "m2", type: "message", text: "{{product|Mahsulot}} narxi: {{vars.price|menejer aytadi}}. Katalogni ham yuboraymi?" },
      {
        id: "b1",
        type: "button",
        text: "Tanlang:",
        buttons: [
          { id: "cat", label: "Katalog" },
          { id: "ph", label: "Raqamimni qoldiraman", kind: "phone", saveAs: "phone" },
        ],
      },
      { id: "m3", type: "message", text: "Katalog: {{vars.catalog_url|menejer yuboradi}}. Qiziqsa raqamingizni qoldiring 👇" },
      {
        id: "b2",
        type: "button",
        text: "Raqamingizni qoldiring:",
        buttons: [
          { id: "ph2", label: "Raqamni yuborish", kind: "phone", saveAs: "phone" },
          { id: "later", label: "Keyinroq" },
        ],
      },
      { id: "lead", type: "lead", phoneFrom: "vars.phone", summary: "Komment orqali narx so'radi", thanks: "Rahmat! Tez orada bog'lanamiz." },
      { id: "tag", type: "tag", action: "add", tagSlugs: ["lead", "narx"] },
      { id: "tg", type: "action", action: "notify_telegram", text: "🔥 Yangi lead: @{{username}} {{vars.phone}} — {{trigger.text}}" },
      { id: "bye", type: "message", text: "Yaxshi, savol bo'lsa shu yerga yozing 🙂" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "m2", handle: "tap" },
      { from: "m2", to: "b1", handle: "next" },
      { from: "b1", to: "m3", handle: "tap:cat" },
      { from: "b1", to: "lead", handle: "tap:ph" },
      { from: "b1", to: "m3", handle: "other" },
      { from: "m3", to: "b2", handle: "next" },
      { from: "b2", to: "lead", handle: "tap:ph2" },
      { from: "b2", to: "bye", handle: "tap:later" },
      { from: "b2", to: "bye", handle: "other" },
      { from: "bye", to: "end", handle: "next" },
      { from: "lead", to: "tag", handle: "next" },
      { from: "lead", to: "bye", handle: "missing" },
      { from: "tag", to: "tg", handle: "next" },
      { from: "tg", to: "end", handle: "next" },
    ],
  },
};
