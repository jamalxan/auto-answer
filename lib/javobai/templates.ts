/**
 * Fixed replies of the sales agent: what goes out when the model is down,
 * blocked by the post-filter, has no fact to stand on, or when code decides
 * the outcome (handoff, phone captured). Production's templates
 * (lib/assistant/templates.ts) are reused for the generic stages; these are
 * the ETAP 4 additions. 1–2 variants per language.
 */

import type { Lang } from "@/lib/assistant/language";
import type { HandoffReason } from "./config";

export type JavobAiTemplateKey =
  | "unknown"
  | "ask_budget"
  | "ask_location"
  | "ask_product"
  | "ask_phone"
  | "ask_phone_purchase"
  | "handoff_human"
  | "handoff_complaint"
  | "handoff_unknown"
  | "handoff_purchase"
  | "handoff_generic"
  | "silent_pending"
  | "voice_unclear"
  | "budget_paused";

type Variants = Record<Lang, string[]>;

export const JAVOBAI_TEMPLATES: Record<JavobAiTemplateKey, Variants> = {
  unknown: {
    uz_latn: [
      "Bu ma'lumot menda yo'q, menejerimiz aniqlab beradi.",
      "Buni aniq ayta olmayman — menejerimiz aniqlab, javob beradi.",
    ],
    uz_cyrl: [
      "Бу маълумот менда йўқ, менежеримиз аниқлаб беради.",
      "Буни аниқ айта олмайман — менежеримиз аниқлаб, жавоб беради.",
    ],
    ru: [
      "У меня нет этой информации, менеджер уточнит и ответит.",
      "Точно сказать не могу — менеджер уточнит и напишет вам.",
    ],
  },
  ask_product: {
    uz_latn: ["Qaysi mahsulot yoki xizmat sizni qiziqtiryapti?"],
    uz_cyrl: ["Қайси маҳсулот ёки хизмат сизни қизиқтиряпти?"],
    ru: ["Какой товар или услуга вас интересует?"],
  },
  ask_budget: {
    uz_latn: ["Taxminan qanday byudjetni mo'ljallayapsiz?"],
    uz_cyrl: ["Тахминан қандай бюджетни мўлжаллаяпсиз?"],
    ru: ["На какой бюджет примерно ориентируетесь?"],
  },
  ask_location: {
    uz_latn: ["Qaysi shahar yoki hududdasiz?"],
    uz_cyrl: ["Қайси шаҳар ёки ҳудуддасиз?"],
    ru: ["В каком городе или районе вы находитесь?"],
  },
  ask_phone: {
    uz_latn: [
      "Menejerimiz batafsil aytib berishi uchun telefon raqamingizni qoldirasizmi?",
      "Raqamingizni yozib yuborsangiz, menejerimiz o'zi bog'lanadi.",
    ],
    uz_cyrl: [
      "Менежеримиз батафсил айтиб бериши учун телефон рақамингизни қолдирасизми?",
      "Рақамингизни ёзиб юборсангиз, менежеримиз ўзи боғланади.",
    ],
    ru: [
      "Оставите номер телефона, чтобы менеджер рассказал подробнее?",
      "Напишите номер — менеджер сам свяжется с вами.",
    ],
  },
  ask_phone_purchase: {
    uz_latn: ["Ajoyib! Buyurtmani rasmiylashtirish uchun telefon raqamingizni yozib yuboring."],
    uz_cyrl: ["Ажойиб! Буюртмани расмийлаштириш учун телефон рақамингизни ёзиб юборинг."],
    ru: ["Отлично! Напишите номер телефона, чтобы оформить заказ."],
  },
  handoff_human: {
    uz_latn: ["Albatta, menejerimizga uzatdim — tez orada shu yerda javob beradi."],
    uz_cyrl: ["Албатта, менежеримизга узатдим — тез орада шу ерда жавоб беради."],
    ru: ["Конечно, передал менеджеру — он скоро ответит вам здесь."],
  },
  handoff_complaint: {
    uz_latn: ["Noqulaylik uchun uzr. Menejerimizga uzatdim, tez orada shu yerda javob beradi."],
    uz_cyrl: ["Ноқулайлик учун узр. Менежеримизга узатдим, тез орада шу ерда жавоб беради."],
    ru: ["Приносим извинения. Передал менеджеру, он скоро ответит вам здесь."],
  },
  handoff_unknown: {
    uz_latn: ["Bu savollarga menejerimiz aniq javob beradi — uzatdim, tez orada yozadi."],
    uz_cyrl: ["Бу саволларга менежеримиз аниқ жавоб беради — узатдим, тез орада ёзади."],
    ru: ["На эти вопросы точно ответит менеджер — передал, он скоро напишет."],
  },
  handoff_purchase: {
    uz_latn: ["Rahmat! Menejerimiz buyurtmani rasmiylashtirish uchun tez orada bog'lanadi."],
    uz_cyrl: ["Раҳмат! Менежеримиз буюртмани расмийлаштириш учун тез орада боғланади."],
    ru: ["Спасибо! Менеджер скоро свяжется с вами, чтобы оформить заказ."],
  },
  handoff_generic: {
    uz_latn: ["Menejerimizga uzatdim — tez orada siz bilan bog'lanadi."],
    uz_cyrl: ["Менежеримизга узатдим — тез орада сиз билан боғланади."],
    ru: ["Передал менеджеру — он скоро свяжется с вами."],
  },
  silent_pending: {
    uz_latn: ["Menejerimiz tez orada javob beradi."],
    uz_cyrl: ["Менежеримиз тез орада жавоб беради."],
    ru: ["Менеджер скоро ответит."],
  },
  // 4.3: a voice note that could not be transcribed (empty, low confidence, too large, STT down, cap).
  voice_unclear: {
    uz_latn: ["Ovozli xabarni tushunolmadim, iltimos yozib yuboring 🙏"],
    uz_cyrl: ["Овозли хабарни тушунолмадим, илтимос ёзиб юборинг 🙏"],
    ru: ["Не удалось разобрать голосовое, напишите, пожалуйста, текстом 🙏"],
  },
  // 4.4: the workspace's hard AI budget is spent — sent once per conversation, then a manager answers.
  budget_paused: {
    uz_latn: ["AI yordamchi vaqtincha o'chirilgan, menejerimiz tez orada shu yerda javob beradi."],
    uz_cyrl: ["AI ёрдамчи вақтинча ўчирилган, менежеримиз тез орада шу ерда жавоб беради."],
    ru: ["AI-помощник временно отключён, менеджер скоро ответит вам здесь."],
  },
};

export function pickJavobAiTemplate(
  key: JavobAiTemplateKey,
  options: { lang: Lang; avoid?: string | null }
): string {
  const variants = JAVOBAI_TEMPLATES[key][options.lang] ?? JAVOBAI_TEMPLATES[key].uz_latn;
  const fresh = variants.filter((v) => v !== options.avoid);
  const pool = fresh.length > 0 ? fresh : variants;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The reply that closes the AI's part when a handoff opens. */
export function handoffTemplateFor(reason: HandoffReason, lang: Lang): string {
  switch (reason) {
    case "wants_human":
      return pickJavobAiTemplate("handoff_human", { lang });
    case "complaint":
    case "sensitive":
      return pickJavobAiTemplate("handoff_complaint", { lang });
    case "unknown_streak":
      return pickJavobAiTemplate("handoff_unknown", { lang });
    case "purchase_ready":
    case "phone_captured":
      return pickJavobAiTemplate("handoff_purchase", { lang });
    case "budget":
      return pickJavobAiTemplate("budget_paused", { lang });
    default:
      return pickJavobAiTemplate("handoff_generic", { lang });
  }
}

/** The qualification question for a field, in the customer's language. */
export function qualificationTemplate(field: "product" | "budget" | "location", lang: Lang): string {
  const key = field === "product" ? "ask_product" : field === "budget" ? "ask_budget" : "ask_location";
  return pickJavobAiTemplate(key, { lang });
}
