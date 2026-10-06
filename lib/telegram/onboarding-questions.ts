/**
 * The owner Q&A (TZ 3A.3) as configuration: change the order or the wording
 * here, no FSM code needs to move. Texts exist in Uzbek (Latin) and Russian.
 */

export type BotLang = "uz" | "ru";

export type QuestionKind =
  | "text" // free text or voice, confirmed after cleanup
  | "short_text" // single line, no LLM cleanup (company name)
  | "products" // text / voice / photo / xlsx / csv / pdf
  | "single_choice" // inline buttons, one value
  | "choice_or_text" // buttons plus an "Other" free-text escape
  | "multi_choice" // toggle buttons + Done
  | "location_text" // text or a Telegram location
  | "faq"; // repeating Q&A pairs

export interface ChoiceOption {
  value: string;
  label: Record<BotLang, string>;
}

export interface OnboardingQuestion {
  id: string;
  /** Key inside `answers`. */
  key: string;
  kind: QuestionKind;
  required: boolean;
  text: Record<BotLang, string>;
  options?: ChoiceOption[];
  /** For free-text questions: shorten to at most N sentences. */
  maxSentences?: number;
}

const OTHER: ChoiceOption = { value: "__other", label: { uz: "Boshqa", ru: "Другое" } };

export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    id: "company_name",
    key: "company_name",
    kind: "short_text",
    required: true,
    text: { uz: "Kompaniyangiz nomi qanday?", ru: "Как называется ваша компания?" },
  },
  {
    id: "description",
    key: "description",
    kind: "text",
    required: true,
    maxSentences: 3,
    text: {
      uz: "Nima bilan shug'ullanasiz? 1–2 gapda yozing yoki ovozli xabar yuboring.",
      ru: "Чем вы занимаетесь? Напишите в 1–2 предложениях или отправьте голосовое сообщение.",
    },
  },
  {
    id: "products",
    key: "products",
    kind: "products",
    required: true,
    text: {
      uz: "Qanday mahsulot yoki xizmatlaringiz bor? Har qatorga bittadan yozing: <i>nom — narx</i>.\nNarxlar ro'yxati rasmi, Excel, CSV yoki PDF fayl ham yuborishingiz mumkin.",
      ru: "Какие у вас товары или услуги? Пишите по одному в строке: <i>название — цена</i>.\nМожно отправить фото прайс-листа, Excel, CSV или PDF файл.",
    },
  },
  {
    id: "price_policy",
    key: "price_policy",
    kind: "single_choice",
    required: true,
    text: { uz: "Narxni mijozga aytaylikmi?", ru: "Называть ли клиенту цену?" },
    options: [
      { value: "NEVER", label: { uz: "Yo'q, menejer aytadi", ru: "Нет, скажет менеджер" } },
      { value: "FROM_ONLY", label: { uz: "\"...dan boshlab\" deb aytilsin", ru: "Говорить «от ...»" } },
      { value: "EXACT", label: { uz: "Aniq narxni aytsin", ru: "Называть точную цену" } },
    ],
  },
  {
    id: "address",
    key: "address",
    kind: "location_text",
    required: false,
    text: {
      uz: "Manzilingiz yoki filiallaringiz qayerda? Matn yozing yoki Telegram lokatsiyasini yuboring.",
      ru: "Где находится ваш адрес или филиалы? Напишите текстом или отправьте геолокацию Telegram.",
    },
  },
  {
    id: "working_hours",
    key: "working_hours",
    kind: "choice_or_text",
    required: false,
    text: { uz: "Ish vaqtingiz qanday?", ru: "Какой у вас график работы?" },
    options: [
      { value: "Du–Sha 9:00–18:00", label: { uz: "Du–Sha 9:00–18:00", ru: "Пн–Сб 9:00–18:00" } },
      { value: "Har kuni 9:00–21:00", label: { uz: "Har kuni 9:00–21:00", ru: "Ежедневно 9:00–21:00" } },
      { value: "24/7", label: { uz: "24/7", ru: "24/7" } },
      OTHER,
    ],
  },
  {
    id: "delivery",
    key: "delivery",
    kind: "choice_or_text",
    required: false,
    text: { uz: "Yetkazib berish bormi?", ru: "Есть ли доставка?" },
    options: [
      { value: "Ha, butun O'zbekiston bo'ylab", label: { uz: "Ha, butun O'zbekiston", ru: "Да, по всему Узбекистану" } },
      { value: "Faqat shahar ichida", label: { uz: "Faqat shahar ichida", ru: "Только по городу" } },
      { value: "Yo'q", label: { uz: "Yo'q", ru: "Нет" } },
      OTHER,
    ],
  },
  {
    id: "payment_methods",
    key: "payment_methods",
    kind: "multi_choice",
    required: false,
    text: { uz: "Qanday to'lov usullari bor?", ru: "Какие способы оплаты есть?" },
    options: [
      { value: "Naqd", label: { uz: "Naqd", ru: "Наличные" } },
      { value: "Click", label: { uz: "Click", ru: "Click" } },
      { value: "Payme", label: { uz: "Payme", ru: "Payme" } },
      { value: "Uzum", label: { uz: "Uzum", ru: "Uzum" } },
      { value: "Karta", label: { uz: "Karta", ru: "Карта" } },
      { value: "Muddatli to'lov", label: { uz: "Muddatli to'lov", ru: "Рассрочка" } },
    ],
  },
  {
    id: "faqs",
    key: "faqs",
    kind: "faq",
    required: false,
    text: {
      uz: "Mijozlar eng ko'p nima so'raydi? Savol va javobni yozing (5 tagacha), masalan:\n<i>Kafolat bormi? Ha, 1 yil.</i>",
      ru: "Что клиенты спрашивают чаще всего? Напишите вопрос и ответ (до 5), например:\n<i>Есть гарантия? Да, 1 год.</i>",
    },
  },
  {
    id: "extra_field",
    key: "extra_field_label",
    kind: "choice_or_text",
    required: false,
    text: {
      uz: "Mijozdan raqamdan tashqari yana nima so'raylik?",
      ru: "Что ещё спрашивать у клиента, кроме номера?",
    },
    options: [
      { value: "__none", label: { uz: "Hech narsa", ru: "Ничего" } },
      { value: "Shahar", label: { uz: "Shahar", ru: "Город" } },
      OTHER,
    ],
  },
  {
    id: "tone",
    key: "tone",
    kind: "single_choice",
    required: false,
    text: { uz: "Assistent qanday ohangda yozsin?", ru: "В каком тоне должен писать ассистент?" },
    options: [
      { value: "FRIENDLY", label: { uz: "Samimiy", ru: "Дружелюбно" } },
      { value: "FORMAL", label: { uz: "Rasmiy", ru: "Официально" } },
    ],
  },
];

export const OTHER_VALUE = "__other";
export const NONE_VALUE = "__none";
export const MAX_FAQS = 5;

export function questionAt(index: number): OnboardingQuestion | undefined {
  return ONBOARDING_QUESTIONS[index];
}

export function indexOfQuestion(id: string): number {
  return ONBOARDING_QUESTIONS.findIndex((q) => q.id === id);
}

/** Section buttons shown by "Bo'limni tahrirlash". */
export const SECTION_LABELS: Record<string, Record<BotLang, string>> = {
  company_name: { uz: "Kompaniya nomi", ru: "Название" },
  description: { uz: "Tavsif", ru: "Описание" },
  products: { uz: "Mahsulotlar", ru: "Товары" },
  price_policy: { uz: "Narx siyosati", ru: "Политика цен" },
  address: { uz: "Manzil", ru: "Адрес" },
  working_hours: { uz: "Ish vaqti", ru: "График" },
  delivery: { uz: "Yetkazish", ru: "Доставка" },
  payment_methods: { uz: "To'lov", ru: "Оплата" },
  faqs: { uz: "Savol-javoblar", ru: "Вопросы-ответы" },
  extra_field: { uz: "Qo'shimcha maydon", ru: "Доп. поле" },
  tone: { uz: "Ohang", ru: "Тон" },
};
