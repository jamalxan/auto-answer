/**
 * Fallback templates: used when the LLM is unavailable, when its answer is
 * blocked by the post-filter, and for fixed situations (media message, final
 * message, "manager will answer"). 2–3 variants per language and stage so the
 * same sentence is never sent twice in a row.
 */

import type { Lang } from "./language";

export type TemplateKey =
  | "new"
  | "need"
  | "contact"
  | "contact_name_known"
  | "contact_last"
  | "bad_phone"
  | "media"
  | "fallback_final"
  | "complaint"
  | "off_hours"
  | "after_handoff";

type Variants = Record<Lang, string[]>;

export const TEMPLATES: Record<TemplateKey, Variants> = {
  new: {
    uz_latn: [
      "Assalomu alaykum! Qaysi mahsulot yoki xizmat sizni qiziqtiryapti?",
      "Salom! Sizga qanday yordam bera olaman — nima qidiryapsiz?",
    ],
    uz_cyrl: [
      "Ассалому алайкум! Қайси маҳсулот ёки хизмат сизни қизиқтиряпти?",
      "Салом! Сизга қандай ёрдам бера оламан — нима қидиряпсиз?",
    ],
    ru: [
      "Здравствуйте! Какой товар или услуга вас интересует?",
      "Привет! Чем могу помочь — что вы ищете?",
    ],
  },
  need: {
    uz_latn: [
      "Tushundim. Biroz aniqroq aytsangiz — aynan nima kerak?",
      "Yaxshi. Qaysi turi yoki modeli qiziqtiryapti?",
    ],
    uz_cyrl: [
      "Тушундим. Бироз аниқроқ айтсангиз — айнан нима керак?",
      "Яхши. Қайси тури ёки модели қизиқтиряпти?",
    ],
    ru: [
      "Понял. Уточните, пожалуйста, что именно нужно?",
      "Хорошо. Какой вид или модель вас интересует?",
    ],
  },
  contact: {
    uz_latn: [
      "Menejerimiz batafsil aytib beradi. Ismingiz va raqamingizni qoldirasizmi?",
      "To'liq ma'lumotni menejerimiz aytadi. Ismingiz va telefon raqamingiz?",
      "Menejer siz bilan bog'lansin — ism va raqamingizni yozib yuborasizmi?",
    ],
    uz_cyrl: [
      "Менежеримиз батафсил айтиб беради. Исмингиз ва рақамингизни қолдирасизми?",
      "Тўлиқ маълумотни менежеримиз айтади. Исмингиз ва телефон рақамингиз?",
      "Менежер сиз билан боғлансин — исм ва рақамингизни ёзиб юборасизми?",
    ],
    ru: [
      "Подробности расскажет наш менеджер. Оставите имя и номер телефона?",
      "Менеджер всё расскажет подробно. Как вас зовут и какой у вас номер?",
      "Пусть менеджер свяжется с вами — напишете имя и номер?",
    ],
  },
  contact_name_known: {
    uz_latn: [
      "{name}, menejerimiz bog'lanishi uchun telefon raqamingizni yozasizmi?",
      "{name}, raqamingizni qoldirsangiz, menejerimiz o'zi qo'ng'iroq qiladi.",
    ],
    uz_cyrl: [
      "{name}, менежеримиз боғланиши учун телефон рақамингизни ёзасизми?",
      "{name}, рақамингизни қолдирсангиз, менежеримиз ўзи қўнғироқ қилади.",
    ],
    ru: [
      "{name}, напишете номер телефона, чтобы менеджер мог связаться?",
      "{name}, оставьте номер — менеджер сам вам позвонит.",
    ],
  },
  contact_last: {
    uz_latn: ["Agar qulay bo'lsa, raqamingizni qoldiring — menejerimiz tez javob beradi."],
    uz_cyrl: ["Агар қулай бўлса, рақамингизни қолдиринг — менежеримиз тез жавоб беради."],
    ru: ["Если удобно, оставьте номер — менеджер быстро ответит."],
  },
  bad_phone: {
    uz_latn: ["Raqam to'liq emasga o'xshaydi, iltimos 90 123 45 67 ko'rinishida yozing."],
    uz_cyrl: ["Рақам тўлиқ эмасга ўхшайди, илтимос 90 123 45 67 кўринишида ёзинг."],
    ru: ["Похоже, номер неполный. Напишите, пожалуйста, в виде 90 123 45 67."],
  },
  media: {
    uz_latn: ["Rasmni menejerimiz ko'rib chiqadi. Ismingiz va raqamingizni qoldirasizmi?"],
    uz_cyrl: ["Расмни менежеримиз кўриб чиқади. Исмингиз ва рақамингизни қолдирасизми?"],
    ru: ["Фото посмотрит наш менеджер. Оставите имя и номер телефона?"],
  },
  fallback_final: {
    uz_latn: ["Mayli, menejerimiz shu yerda yozib javob beradi."],
    uz_cyrl: ["Майли, менежеримиз шу ерда ёзиб жавоб беради."],
    ru: ["Хорошо, менеджер ответит вам прямо здесь."],
  },
  complaint: {
    uz_latn: [
      "Noqulaylik uchun uzr. Menejerimiz tezroq bog'lanishi uchun raqamingizni yozing.",
    ],
    uz_cyrl: [
      "Ноқулайлик учун узр. Менежеримиз тезроқ боғланиши учун рақамингизни ёзинг.",
    ],
    ru: ["Приносим извинения. Напишите номер, чтобы менеджер связался с вами как можно скорее."],
  },
  off_hours: {
    uz_latn: ["Hozir ish vaqtidan tashqari, lekin menejerimiz ertalab bog'lanadi. Ismingiz va raqamingiz?"],
    uz_cyrl: ["Ҳозир иш вақтидан ташқари, лекин менежеримиз эрталаб боғланади. Исмингиз ва рақамингиз?"],
    ru: ["Сейчас нерабочее время, но менеджер свяжется с вами утром. Ваше имя и номер?"],
  },
  after_handoff: {
    uz_latn: ["Menejerimiz tez orada javob beradi."],
    uz_cyrl: ["Менежеримиз тез орада жавоб беради."],
    ru: ["Менеджер скоро ответит."],
  },
};

const DEFAULT_FINAL: Variants = {
  uz_latn: ["Rahmat, {name}! Menejerimiz tez orada {phone} raqamiga bog'lanadi."],
  uz_cyrl: ["Раҳмат, {name}! Менежеримиз тез орада {phone} рақамига боғланади."],
  ru: ["Спасибо, {name}! Менеджер скоро свяжется с вами по номеру {phone}."],
};

const NO_NAME: Record<Lang, string> = {
  uz_latn: "do'st",
  uz_cyrl: "дўст",
  ru: "друг",
};

/** +998901234567 -> +998 90 123 45 67 for display in the final message. */
export function formatPhoneForDisplay(e164: string): string {
  const m = e164.match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}

export interface PickOptions {
  lang: Lang;
  /** Last bot message — the same text is never repeated back to back. */
  avoid?: string | null;
  vars?: Record<string, string>;
}

function fill(text: string, vars: Record<string, string> = {}): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

export function pickTemplate(key: TemplateKey, options: PickOptions): string {
  const variants = TEMPLATES[key][options.lang] ?? TEMPLATES[key].uz_latn;
  const rendered = variants.map((v) => fill(v, options.vars));
  const fresh = rendered.filter((v) => v !== options.avoid);
  const pool = fresh.length > 0 ? fresh : rendered;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function renderFinalMessage(opts: {
  lang: Lang;
  name: string | null;
  phoneE164: string;
  template?: string | null;
}): string {
  const template =
    opts.template?.trim() || DEFAULT_FINAL[opts.lang][0] || DEFAULT_FINAL.uz_latn[0];
  return fill(template, {
    name: opts.name?.trim() || NO_NAME[opts.lang],
    phone: formatPhoneForDisplay(opts.phoneE164),
  });
}
