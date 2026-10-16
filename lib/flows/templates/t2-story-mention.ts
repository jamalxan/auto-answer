/**
 * T2 — story mention → thank-you DM with the offer → details / phone → lead.
 */

import type { FlowStarterTemplateInput } from "./types";

export const T2_STORY_MENTION: FlowStarterTemplateInput = {
  key: "story_mention_dm",
  name: "Story'da belgilash → Direct taklif",
  description: "Sizni story'da belgilagan odamga rahmat va taklif yuboriladi; qiziqsa shartlar yoki telefon raqami so'raladi.",
  triggerType: "STORY_MENTION",
  category: "story",
  tags: ["story"],
  graph: {
    v: 1,
    variables: [
      { key: "phone", label: "Telefon", kind: "phone" },
      { key: "offer", label: "Taklif matni", kind: "string" },
      { key: "terms", label: "Shartlar", kind: "string" },
    ],
    nodes: [
      { id: "t", type: "trigger", triggerType: "STORY_MENTION", matchingMode: "EVERY", cooldownHours: 24 },
      { id: "m1", type: "message", text: "Rahmat, {{name|do'stim}}! Story'da belgilaganingiz uchun sizga taklif: {{vars.offer|menejer yozadi}}" },
      {
        id: "b1",
        type: "button",
        text: "Nima qilamiz?",
        buttons: [
          { id: "info", label: "Batafsil" },
          { id: "ph", label: "Raqam qoldirish", kind: "phone", saveAs: "phone" },
        ],
      },
      { id: "m2", type: "message", text: "Shartlar: {{vars.terms|menejer yozadi}}. Savol bo'lsa shu yerga yozing 🙂" },
      { id: "tag", type: "tag", action: "add", tagSlugs: ["story"] },
      { id: "lead", type: "lead", phoneFrom: "vars.phone", summary: "Story mention orqali", thanks: "Rahmat! Bog'lanamiz." },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "b1", handle: "next" },
      { from: "b1", to: "m2", handle: "tap:info" },
      { from: "b1", to: "lead", handle: "tap:ph" },
      { from: "b1", to: "m2", handle: "other" },
      { from: "m2", to: "end", handle: "next" },
      { from: "lead", to: "tag", handle: "next" },
      { from: "lead", to: "end", handle: "missing" },
      { from: "tag", to: "end", handle: "next" },
    ],
  },
};
