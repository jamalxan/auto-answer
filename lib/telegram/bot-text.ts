import type { BotLang } from "./onboarding-questions";

export interface BotText {
  skip: string;
  back: string;
  later: string;
  done: string;
  yes: string;
  editIt: string;
  allCorrect: string;
  fix: string;
  addMore: string;
  deleteRow: string;
  language: string;
  progress: (step: number, total: number) => string;
  privateOnly: string;
  privateOnlyLink: (url: string) => string;
  welcome: string;
  notLinked: string;
  notAllowed: string;
  codeInvalid: string;
  chatLinked: (title: string) => string;
  accountPick: string;
  allAccounts: string;
  paused: string;
  resumed: (step: number, total: number) => string;
  noActiveSession: string;
  understood: (text: string) => string;
  isThatRight: string;
  voiceFailed: string;
  voiceTooLong: string;
  voiceNoProvider: string;
  needTextAnswer: string;
  tooLong: string;
  saved: string;
  requiredAnswer: string;
  productsFound: (n: number) => string;
  noProducts: string;
  fileTooBig: string;
  fileUnsupported: string;
  fileFailed: string;
  scannedPdf: string;
  pickRowToFix: string;
  rowNotFound: string;
  newRowValue: string;
  pickRowToDelete: string;
  addProductsPrompt: string;
  askPriceAgain: (name: string) => string;
  replaceOrAdd: string;
  replace: string;
  add: string;
  page: (n: number, total: number) => string;
  prev: string;
  next: string;
  promptWarning: string;
  faqSaved: (n: number) => string;
  faqNeedFormat: string;
  faqLimit: string;
  otherPrompt: string;
  summaryTitle: string;
  summary: (p: SummaryData) => string;
  approve: string;
  editSection: string;
  tryIt: string;
  approved: string;
  chooseSection: string;
  testStarted: string;
  testStopped: string;
  testHint: string;
  stalled: (step: number, total: number) => string;
  noProfile: string;
  productsHeader: (n: number) => string;
  productAddName: string;
  productAddPrice: (name: string) => string;
  productAdded: (line: string) => string;
  faqHeader: (n: number) => string;
  assistantOn: string;
  assistantOff: string;
  toggleOn: string;
  toggleOff: string;
  pricePolicyLabel: string;
  gapAnswerPrompt: (q: string) => string;
  gapAnswered: string;
  gapIgnored: string;
  priceThanks: string;
  priceUpdatePrompt: string;
  contacted: string;
  notLinkedForLead: string;
}

export interface SummaryData {
  company: string;
  description: string;
  productCount: number;
  topProducts: string[];
  pricePolicy: string;
  address: string | null;
  workingHours: string | null;
  delivery: string | null;
  payment: string | null;
  faqCount: number;
}

export const BOT_TEXT: Record<BotLang, BotText> = {
  uz: {
    skip: "⏭ O'tkazib yuborish",
    back: "◀️ Orqaga",
    later: "⏸ Keyinroq davom ettirish",
    done: "Tayyor ✅",
    yes: "✅ Ha",
    editIt: "✏️ Tuzataman",
    allCorrect: "✅ Hammasi to'g'ri",
    fix: "✏️ Tuzatish",
    addMore: "➕ Yana qo'shish",
    deleteRow: "🗑 Qatorni o'chirish",
    language: "🌐 Русский",
    progress: (s, t) => `${s}/${t}`,
    privateOnly: "Bu bo'lim faqat shaxsiy chatda ishlaydi.",
    privateOnlyLink: (url) => `Bu bo'lim faqat shaxsiy chatda ishlaydi: ${url}`,
    welcome:
      "Salom! Men SocialAuto yordamchisiman. Lidlar shu yerga keladi, assistentni ham shu yerda sozlashingiz mumkin.\nPanelda «Telegram orqali to'ldirish» tugmasini bosing.",
    notLinked: "Avval SocialAuto panelidan havola orqali kiring: Assistent → «Telegram orqali to'ldirish».",
    notAllowed: "Bu amal faqat workspace egasi yoki admini uchun.",
    codeInvalid: "Kod yaroqsiz yoki muddati tugagan. Paneldan yangisini oling.",
    chatLinked: (title) => `✅ Ulandi: ${title}. Endi yangi lidlar shu yerga keladi.`,
    accountPick: "Qaysi akkaunt uchun?",
    allAccounts: "Hammasi uchun bir xil",
    paused: "⏸ To'xtatildi. /profil yozib, shu qadamdan davom ettirasiz.",
    resumed: (s, t) => `Davom etamiz (${s}/${t}).`,
    noActiveSession: "Faol sozlash yo'q. /profil yozing.",
    understood: (text) => `Shunday tushundim: «${text}». To'g'rimi?`,
    isThatRight: "To'g'rimi?",
    voiceFailed: "Ovozni matnga aylantirib bo'lmadi. Matn yozing yoki qayta yuboring.",
    voiceTooLong: "Ovozli xabar 3 daqiqadan oshmasin (20 MB gacha).",
    voiceNoProvider: "Ovozni matnga aylantirish sozlanmagan. Iltimos, matn yozing.",
    needTextAnswer: "Matn yoki ovozli xabar yuboring.",
    tooLong: "Biroz qisqaroq yozing, iltimos.",
    saved: "Saqlandi ✅",
    requiredAnswer: "Bu savol majburiy — javob yozing.",
    productsFound: (n) => `Quyidagilarni topdim (${n} ta):`,
    noProducts: "Mahsulot topa olmadim. Har qatorga «nom — narx» yozing yoki fayl yuboring.",
    fileTooBig: "Fayl juda katta (5 MB gacha).",
    fileUnsupported: "Bu fayl turini o'qiy olmayman. Excel (.xlsx), CSV, PDF yoki rasm yuboring.",
    fileFailed: "Faylni o'qib bo'lmadi. Boshqa fayl yuboring yoki matn yozing.",
    scannedPdf: "Bu PDF skan qilingan ko'rinadi. Iltimos, sahifalarni rasm qilib yuboring.",
    pickRowToFix: "Qaysi qatorni tuzatamiz? Raqamini yuboring.",
    rowNotFound: "Bunday qator yo'q. Raqamni qayta yuboring.",
    newRowValue: "Yangi qiymatni yozing: «nom — narx».",
    pickRowToDelete: "Qaysi qatorni o'chiramiz? Raqamini yuboring.",
    addProductsPrompt: "Qo'shiladigan mahsulotlarni yozing yoki fayl yuboring.",
    askPriceAgain: (name) => `«${name}» narxini tushunmadim. Narxni qayta yozing (masalan 1 200 000 yoki 300 ming).`,
    replaceOrAdd: "Eskisini almashtiraymi yoki qo'shaymi?",
    replace: "♻️ Almashtirish",
    add: "➕ Qo'shish",
    page: (n, t) => `Sahifa ${n}/${t}`,
    prev: "◀️",
    next: "▶️",
    promptWarning:
      "⚠️ Matnda assistentga ko'rsatma o'xshash jumlalar bor. Assistent baribir o'z qat'iy qoidalariga amal qiladi (masalan chegirma va'da qilmaydi).",
    faqSaved: (n) => `Savol-javob qo'shildi (${n}/5). Yana yozing yoki «Tayyor»ni bosing.`,
    faqNeedFormat: "«Savol? Javob» ko'rinishida yozing.",
    faqLimit: "5 ta savol-javobga yetdingiz.",
    otherPrompt: "Matn bilan yozing:",
    summaryTitle: "📋 Yig'ma karta",
    summary: (p) =>
      [
        `🏢 ${p.company}`,
        p.description,
        `🛍 Mahsulotlar: ${p.productCount} ta${p.topProducts.length ? `\n${p.topProducts.map((x) => `  • ${x}`).join("\n")}` : ""}`,
        `💰 Narx siyosati: ${p.pricePolicy}`,
        p.address ? `📍 ${p.address}` : null,
        p.workingHours ? `🕘 ${p.workingHours}` : null,
        p.delivery ? `🚚 ${p.delivery}` : null,
        p.payment ? `💳 ${p.payment}` : null,
        `❓ Savol-javoblar: ${p.faqCount} ta`,
      ]
        .filter(Boolean)
        .join("\n"),
    approve: "✅ Tasdiqlash va assistentni yoqish",
    editSection: "✏️ Bo'limni tahrirlash",
    tryIt: "🧪 Sinab ko'rish",
    approved: "🎉 Tayyor! Assistent yoqildi. /profil — o'zgartirish, /test — sinov chati.",
    chooseSection: "Qaysi bo'limni tahrirlaymiz?",
    testStarted: "🧪 Sinov chati. Siz mijozsiz — yozing, assistent javob beradi (Instagram'ga hech narsa yuborilmaydi). Chiqish: /stop_test",
    testStopped: "Sinov tugadi.",
    testHint: "(sinov)",
    stalled: (s, t) => `Sozlash ${s}/${t} da to'xtagan, davom ettiramizmi? /profil`,
    noProfile: "Profil hali sozlanmagan. Panelda «Telegram orqali to'ldirish» tugmasini bosing.",
    productsHeader: (n) => `🛍 Mahsulotlar (${n} ta)`,
    productAddName: "Mahsulot nomini yozing (yoki ovoz yuboring):",
    productAddPrice: (name) => `«${name}» narxi qancha? (masalan 1 200 000, 300 ming, $300)`,
    productAdded: (line) => `Qo'shildi: ${line}`,
    faqHeader: (n) => `❓ Savol-javoblar (${n} ta)`,
    assistantOn: "🟢 Assistent yoqilgan",
    assistantOff: "⚪️ Assistent o'chirilgan",
    toggleOn: "Yoqish",
    toggleOff: "O'chirish",
    pricePolicyLabel: "Narx siyosati",
    gapAnswerPrompt: (q) => `«${q}» savoliga javobingizni yozing (yoki ovoz yuboring):`,
    gapAnswered: "Rahmat! Assistent endi bu savolga javob beradi ✅",
    gapIgnored: "Yaxshi, bu savolni e'tiborsiz qoldirdim.",
    priceThanks: "Rahmat! 👍",
    priceUpdatePrompt: "Yangi narxlarni yuboring: matn, rasm, Excel, CSV yoki PDF.",
    contacted: "Bog'lanildi",
    notLinkedForLead: "Bu chat ulanmagan.",
  },
  ru: {
    skip: "⏭ Пропустить",
    back: "◀️ Назад",
    later: "⏸ Продолжить позже",
    done: "Готово ✅",
    yes: "✅ Да",
    editIt: "✏️ Исправлю",
    allCorrect: "✅ Всё верно",
    fix: "✏️ Исправить",
    addMore: "➕ Добавить ещё",
    deleteRow: "🗑 Удалить строку",
    language: "🌐 O'zbekcha",
    progress: (s, t) => `${s}/${t}`,
    privateOnly: "Этот раздел работает только в личном чате.",
    privateOnlyLink: (url) => `Этот раздел работает только в личном чате: ${url}`,
    welcome:
      "Здравствуйте! Я помощник SocialAuto. Сюда приходят лиды, и здесь же можно настроить ассистента.\nНажмите «Заполнить через Telegram» в панели.",
    notLinked: "Сначала зайдите по ссылке из панели SocialAuto: Ассистент → «Заполнить через Telegram».",
    notAllowed: "Это действие доступно только владельцу или админу workspace.",
    codeInvalid: "Код недействителен или истёк. Получите новый в панели.",
    chatLinked: (title) => `✅ Подключено: ${title}. Теперь новые лиды будут приходить сюда.`,
    accountPick: "Для какого аккаунта?",
    allAccounts: "Одинаково для всех",
    paused: "⏸ Приостановлено. Напишите /profil, чтобы продолжить с этого шага.",
    resumed: (s, t) => `Продолжаем (${s}/${t}).`,
    noActiveSession: "Нет активной настройки. Напишите /profil.",
    understood: (text) => `Я понял так: «${text}». Верно?`,
    isThatRight: "Верно?",
    voiceFailed: "Не удалось распознать голос. Напишите текстом или отправьте ещё раз.",
    voiceTooLong: "Голосовое не длиннее 3 минут (до 20 МБ).",
    voiceNoProvider: "Распознавание голоса не настроено. Пожалуйста, напишите текстом.",
    needTextAnswer: "Отправьте текст или голосовое сообщение.",
    tooLong: "Напишите, пожалуйста, покороче.",
    saved: "Сохранено ✅",
    requiredAnswer: "Этот вопрос обязательный — напишите ответ.",
    productsFound: (n) => `Нашёл (${n} шт.):`,
    noProducts: "Не нашёл товаров. Напишите по строке «название — цена» или отправьте файл.",
    fileTooBig: "Файл слишком большой (до 5 МБ).",
    fileUnsupported: "Не могу прочитать этот тип файла. Отправьте Excel (.xlsx), CSV, PDF или фото.",
    fileFailed: "Не удалось прочитать файл. Отправьте другой или напишите текстом.",
    scannedPdf: "Похоже, это отсканированный PDF. Пришлите страницы фотографиями.",
    pickRowToFix: "Какую строку исправим? Отправьте номер.",
    rowNotFound: "Такой строки нет. Отправьте номер ещё раз.",
    newRowValue: "Напишите новое значение: «название — цена».",
    pickRowToDelete: "Какую строку удалить? Отправьте номер.",
    addProductsPrompt: "Напишите товары для добавления или отправьте файл.",
    askPriceAgain: (name) => `Не понял цену «${name}». Напишите цену ещё раз (например 1 200 000 или 300 тыс).`,
    replaceOrAdd: "Заменить старый список или добавить к нему?",
    replace: "♻️ Заменить",
    add: "➕ Добавить",
    page: (n, t) => `Страница ${n}/${t}`,
    prev: "◀️",
    next: "▶️",
    promptWarning:
      "⚠️ В тексте есть фразы, похожие на указания для ассистента. Ассистент всё равно следует своим жёстким правилам (например, не обещает скидок).",
    faqSaved: (n) => `Вопрос-ответ добавлен (${n}/5). Напишите ещё или нажмите «Готово».`,
    faqNeedFormat: "Напишите в формате «Вопрос? Ответ».",
    faqLimit: "Вы достигли 5 вопросов-ответов.",
    otherPrompt: "Напишите текстом:",
    summaryTitle: "📋 Сводка",
    summary: (p) =>
      [
        `🏢 ${p.company}`,
        p.description,
        `🛍 Товары: ${p.productCount} шт.${p.topProducts.length ? `\n${p.topProducts.map((x) => `  • ${x}`).join("\n")}` : ""}`,
        `💰 Политика цен: ${p.pricePolicy}`,
        p.address ? `📍 ${p.address}` : null,
        p.workingHours ? `🕘 ${p.workingHours}` : null,
        p.delivery ? `🚚 ${p.delivery}` : null,
        p.payment ? `💳 ${p.payment}` : null,
        `❓ Вопросы-ответы: ${p.faqCount} шт.`,
      ]
        .filter(Boolean)
        .join("\n"),
    approve: "✅ Подтвердить и включить ассистента",
    editSection: "✏️ Править раздел",
    tryIt: "🧪 Попробовать",
    approved: "🎉 Готово! Ассистент включён. /profil — изменить, /test — тестовый чат.",
    chooseSection: "Какой раздел правим?",
    testStarted: "🧪 Тестовый чат. Вы — клиент: пишите, ассистент ответит (в Instagram ничего не отправляется). Выход: /stop_test",
    testStopped: "Тест завершён.",
    testHint: "(тест)",
    stalled: (s, t) => `Настройка остановилась на ${s}/${t}, продолжим? /profil`,
    noProfile: "Профиль ещё не настроен. Нажмите «Заполнить через Telegram» в панели.",
    productsHeader: (n) => `🛍 Товары (${n} шт.)`,
    productAddName: "Напишите название товара (или отправьте голосовое):",
    productAddPrice: (name) => `Сколько стоит «${name}»? (например 1 200 000, 300 тыс, $300)`,
    productAdded: (line) => `Добавлено: ${line}`,
    faqHeader: (n) => `❓ Вопросы-ответы (${n} шт.)`,
    assistantOn: "🟢 Ассистент включён",
    assistantOff: "⚪️ Ассистент выключен",
    toggleOn: "Включить",
    toggleOff: "Выключить",
    pricePolicyLabel: "Политика цен",
    gapAnswerPrompt: (q) => `Напишите ответ на вопрос «${q}» (или отправьте голосовое):`,
    gapAnswered: "Спасибо! Теперь ассистент будет отвечать на этот вопрос ✅",
    gapIgnored: "Хорошо, игнорирую этот вопрос.",
    priceThanks: "Спасибо! 👍",
    priceUpdatePrompt: "Отправьте новые цены: текст, фото, Excel, CSV или PDF.",
    contacted: "Связались",
    notLinkedForLead: "Этот чат не подключён.",
  },
};

export function tr(lang: BotLang): BotText {
  return BOT_TEXT[lang] ?? BOT_TEXT.uz;
}

export function botLangFromTelegram(code: string | undefined | null): BotLang {
  return code && code.toLowerCase().startsWith("ru") ? "ru" : "uz";
}
