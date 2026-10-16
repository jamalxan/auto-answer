/**
 * T5 — giveaway announcement: comment "ishtirok" → confirm button →
 * duplicate check by tag → tag + rules → optional phone → Telegram note.
 * No lead node on purpose: a giveaway phone is not a sales lead (TZ 43).
 */

import type { FlowStarterTemplateInput } from "./types";

export const T5_GIVEAWAY: FlowStarterTemplateInput = {
  key: "giveaway_confirm",
  name: "Konkurs: ishtirokni tasdiqlash",
  description: "Konkurs posti ostiga «ishtirok» yozganlar Direct'da tasdiqlaydi, «konkurs» tegi qo'yiladi, xohlasa raqam qoldiradi. Nusxalagach postni tanlang.",
  triggerType: "COMMENT",
  category: "giveaway",
  tags: ["konkurs"],
  graph: {
    v: 1,
    variables: [
      { key: "phone", label: "Telefon", kind: "phone" },
      { key: "rules", label: "Shartlar", kind: "string" },
      { key: "date", label: "Natijalar sanasi", kind: "string" },
    ],
    nodes: [
      {
        id: "t",
        type: "trigger",
        triggerType: "COMMENT",
        matchingMode: "CONTAINS",
        keywords: ["ishtirok", "qatnashaman", "участвую"],
        publicReply: "Ishtirokingiz qabul qilindi ✅ Direct'ni tekshiring",
      },
      {
        id: "m1",
        type: "message",
        text: "Konkursga xush kelibsiz, {{name|do'stim}}! Ishtirokni tasdiqlash uchun tugmani bosing 👇",
        button: { id: "ok", label: "Tasdiqlayman" },
      },
      {
        id: "c1",
        type: "condition",
        branches: [{ id: "dup", label: "Allaqachon ishtirokchi", when: { v: 1, all: [{ field: "tags", op: "contains", value: "konkurs" }] } }],
      },
      { id: "mdup", type: "message", text: "Siz allaqachon ro'yxatdasiz 🙂 Natijalar: {{vars.date|tez orada}}." },
      { id: "tag", type: "tag", action: "add", tagSlugs: ["konkurs"] },
      { id: "m2", type: "message", text: "Tasdiqlandi 🎉 Shartlar: {{vars.rules|postda}}. Natijalar: {{vars.date|tez orada}}." },
      {
        id: "b1",
        type: "button",
        text: "G'olib bo'lsangiz bog'lanishimiz uchun raqam qoldirasizmi?",
        buttons: [
          { id: "ph", label: "Raqam qoldirish", kind: "phone", saveAs: "phone" },
          { id: "no", label: "Keyinroq" },
        ],
      },
      { id: "a1", type: "action", action: "set_variable", key: "has_phone", value: "1" },
      { id: "tg", type: "action", action: "notify_telegram", text: "🎁 Konkurs ishtirokchisi @{{username}} raqam qoldirdi: {{vars.phone}}" },
      { id: "m3", type: "message", text: "Rahmat! Omad tilaymiz 🍀" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "c1", handle: "tap" },
      { from: "c1", to: "mdup", handle: "branch:dup" },
      { from: "c1", to: "tag", handle: "else" },
      { from: "mdup", to: "end", handle: "next" },
      { from: "tag", to: "m2", handle: "next" },
      { from: "m2", to: "b1", handle: "next" },
      { from: "b1", to: "a1", handle: "tap:ph" },
      { from: "b1", to: "m3", handle: "tap:no" },
      { from: "b1", to: "m3", handle: "other" },
      { from: "a1", to: "tg", handle: "next" },
      { from: "tg", to: "m3", handle: "next" },
      { from: "m3", to: "end", handle: "next" },
    ],
  },
};
