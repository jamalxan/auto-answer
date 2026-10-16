/**
 * ETAP 11 — the ManyChat feature catalogue: what each ManyChat element maps
 * to in SocialAuto, and what has no equivalent. Pure data (uz / ru / en
 * vocabulary in `patterns`, Uzbek Latin messages); the analyser matches it
 * against pasted flow text and the converter uses the verdicts as hints.
 *
 *   SUPPORTED    a SocialAuto node / feature does the same
 *   PARTIAL      works, but with a limit (see `message`)
 *   UNSUPPORTED  no equivalent: `suggestion` names the closest replacement
 *
 * Patterns run on text where every apostrophe variant is "'" and are matched
 * case-insensitively. `\b` is ASCII-only in JS, so Cyrillic patterns use plain
 * stems (`комментари\w*`) instead.
 */

export type FeatureStatus = "SUPPORTED" | "PARTIAL" | "UNSUPPORTED";
export type FeatureCategory = "trigger" | "node" | "channel" | "feature";
export type FindingSeverity = "info" | "warning" | "error";

export interface CatalogEntry {
  key: string;
  category: FeatureCategory;
  /** Short Uzbek name shown in lists. */
  label: string;
  patterns: RegExp[];
  status: FeatureStatus;
  /** The SocialAuto node / trigger / feature this becomes. */
  maps_to?: string;
  message: string;
  suggestion: string;
  /** Default: UNSUPPORTED → error, PARTIAL → warning, SUPPORTED → info. */
  severity?: FindingSeverity;
}

/** One analyser / converter finding (stored on MigrationItem.warnings). */
export interface Finding {
  code: string;
  severity: FindingSeverity;
  message: string;
  suggestion?: string;
  feature?: string;
  count?: number;
}

const re = (source: string) => new RegExp(source, "giu");

export const FEATURE_CATALOG: CatalogEntry[] = [
  // ─── Triggers ──────────────────────────────────────────────────────────────
  {
    key: "trigger_comment",
    category: "trigger",
    label: "Instagram kommentlari (Growth Tool)",
    patterns: [re("instagram\\s+comments?|comments?\\s+(?:growth\\s+tool|trigger|automation)|\\bcomments?\\b|комментари\\w*|коммент\\w*|komment\\w*|izoh\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger COMMENT (Comment 2.0)",
    message: "Komment triggeri COMMENT trigger sifatida o'tadi.",
    suggestion: "Birinchi xabar tugmali private reply bo'ladi; tugma bosilgandan keyingina keyingi xabarlar yuboriladi (24 soatlik oyna qoidasi).",
  },
  {
    key: "trigger_keyword",
    category: "trigger",
    label: "Kalit so'z (Direct)",
    patterns: [re("\\bkeywords?\\b|ключев\\w*\\s+слов\\w*|ключевик\\w*|kalit\\s+so'?z\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger DIRECT_MESSAGE (keywords)",
    message: "Kalit so'z triggeri DIRECT_MESSAGE trigger kalit so'zlariga aylanadi.",
    suggestion: "Moslashtirish rejimini (aniq / ichida) tekshiring.",
  },
  {
    key: "trigger_story_reply",
    category: "trigger",
    label: "Story reply",
    patterns: [re("story\\s+repl(?:y|ies)|repl(?:y|ies)\\s+to\\s+(?:a\\s+|your\\s+)?stor(?:y|ies)|ответ\\w*\\s+на\\s+(?:сторис|истори\\w*)|story'?ga\\s+javob\\w*|story\\s+javob\\w*")],
    status: "PARTIAL",
    maps_to: "Story Reply V1 (alohida modul)",
    message: "Story reply Flow Builder triggeri emas — u alohida «Story Reply» modulida sozlanadi.",
    suggestion: "Story javobini Story Reply modulida yarating; Flow esa to'g'ridan-to'g'ri xabar (DIRECT_MESSAGE) bilan boshlanadi.",
  },
  {
    key: "trigger_story_mention",
    category: "trigger",
    label: "Story mention",
    patterns: [re("story\\s+mentions?|mentions?\\s+(?:you\\s+)?in\\s+(?:a\\s+|their\\s+)?stor(?:y|ies)|упоминани\\w*\\s+в\\s+(?:сторис|истори\\w*)|story'?da\\s+(?:eslat|belgila)\\w*|story\\s+eslatma\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger STORY_MENTION",
    message: "Story mention STORY_MENTION triggeriga o'tadi.",
    suggestion: "Oyna ochiq: birinchi xabar darhol yuborilishi mumkin.",
  },
  {
    key: "trigger_default_reply",
    category: "trigger",
    label: "Default reply",
    patterns: [re("default\\s+repl(?:y|ies)|ответ\\s+по\\s+умолчанию|standart\\s+javob\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger DIRECT_MESSAGE (har qanday xabar)",
    message: "Default reply DIRECT_MESSAGE triggeriga (har qanday xabar, kalit so'zsiz) aylanadi.",
    suggestion: "Bunday oqim boshqa kalit so'zli oqimlardan keyin ishlashi uchun past ustuvorlik bering.",
  },
  {
    key: "trigger_ref",
    category: "trigger",
    label: "Ref URL / ig.me havola",
    patterns: [re("ref\\s*url|ref(?:erral)?\\s+link|\\big\\.me\\b|\\bm\\.me\\b|[?&]ref=|реферальн\\w*\\s+ссылк\\w*|ref\\s+havola\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger DIRECT_MESSAGE (sourceFilter LINK, refs)",
    message: "ig.me?ref=... havolasi Direct trigger manba filtri (LINK) orqali ishlaydi.",
    suggestion: "Yangi akkaunt uchun yangi ig.me havolasini yarating va eskisini almashtiring.",
  },
  {
    key: "trigger_ads",
    category: "trigger",
    label: "Reklama (Click-to-Direct)",
    patterns: [re("click[-\\s]to[-\\s](?:direct|message|messenger|instagram)|\\bads?\\b|реклам\\w*|reklama\\w*")],
    status: "SUPPORTED",
    maps_to: "trigger DIRECT_MESSAGE (sourceFilter ADS)",
    message: "Reklamadan kelgan suhbat manba filtri (ADS) orqali ushlanadi.",
    suggestion: "Reklama ID larini yangi akkaunt bilan qayta bog'lang.",
  },

  // ─── Nodes ─────────────────────────────────────────────────────────────────
  {
    key: "send_message",
    category: "node",
    label: "Xabar yuborish",
    patterns: [re("send\\s+(?:a\\s+)?message|text\\s+card|\\bmessages?\\b|сообщени\\w*|xabar\\w*|matn(?:li)?\\s+karta\\w*")],
    status: "SUPPORTED",
    maps_to: "node message",
    message: "Matnli xabarlar message blokiga aylanadi.",
    suggestion: "Xabar 1000 belgidan (tugmali bo'lsa 640) oshmasligi kerak.",
  },
  {
    key: "quick_reply",
    category: "node",
    label: "Tugmalar / Quick Reply",
    patterns: [re("quick\\s+repl(?:y|ies)|\\bbuttons?\\b|кнопк\\w*|быстр\\w*\\s+ответ\\w*|tugma\\w*|tezkor\\s+javob\\w*")],
    status: "SUPPORTED",
    maps_to: "node button / message.button",
    message: "Tugmalar button blokiga aylanadi (tugma nomi ≤ 20 belgi, ko'pi bilan 13 ta).",
    suggestion: "Uzun tugma nomlari qisqartiriladi; URL tugmalar matnga havola sifatida qo'shiladi.",
  },
  {
    key: "image_card",
    category: "node",
    label: "Rasm kartasi",
    patterns: [re("\\bimages?\\b|\\bphotos?\\b|\\bpictures?\\b|картинк\\w*|изображени\\w*|фото\\b|rasm\\w*|surat\\w*")],
    status: "PARTIAL",
    maps_to: "node message (matn)",
    message: "Flow Builder hozircha rasm yubormaydi — rasmli kartalar matnga aylanadi.",
    suggestion: "Rasm o'rniga matn yoki rasmga havola yuboring; rasmni Instagram postida ko'rsating.",
  },
  {
    key: "media_card",
    category: "node",
    label: "Video / audio / fayl",
    patterns: [re("\\bvideos?\\b|\\baudio\\b|\\bfiles?\\b|видео|аудио|файл\\w*|fayl\\w*")],
    status: "PARTIAL",
    maps_to: "node message (matn + havola)",
    message: "Video, audio va fayl yuborish qo'llab-quvvatlanmaydi — havola matni sifatida o'tadi.",
    suggestion: "Faylni saytga yoki Drive'ga joylab, havolasini xabarga yozing.",
  },
  {
    key: "gallery",
    category: "node",
    label: "Galereya / karusel",
    patterns: [re("\\bgalleries\\b|\\bgallery\\b|carousel\\w*|галере\\w*|карусел\\w*|galereya\\w*|karusel\\w*")],
    status: "PARTIAL",
    maps_to: "node message + 1 tugma",
    message: "Galereya (karusel) yo'q: har bir karta o'rniga matn va bitta tugma yuboriladi.",
    suggestion: "Eng muhim 2–3 kartani matn ro'yxati qilib yozing, tugma orqali tafsilot so'rating.",
  },
  {
    key: "condition",
    category: "node",
    label: "Shart / filtr",
    patterns: [re("\\bconditions?\\b|\\bfilters?\\b|if\\s+(?:the\\s+)?(?:user|contact|subscriber|tag|field)|условие|условия|фильтр\\w*|если\\s+(?:у\\s+)?(?:пользовател|контакт|подписчик|тег|поле)\\w*|\\bshart\\w*|agar\\s+(?:mijoz|foydalanuvchi|teg|maydon|obunachi)\\w*|filtr\\w*")],
    status: "SUPPORTED",
    maps_to: "node condition",
    message: "Shart / filtr condition blokiga aylanadi (teg, maydon, vaqt, ball bo'yicha).",
    suggestion: "ManyChat maydonlari vars.<kalit> sifatida e'lon qilinadi.",
  },
  {
    key: "smart_delay",
    category: "node",
    label: "Kechiktirish (Smart Delay)",
    patterns: [re("smart\\s+delay|\\bdelay\\b|\\bwait\\b|задержк\\w*|подожд\\w*|ожида\\w*|kechiktir\\w*|\\bkut(?:ing|ish|sin|amiz)\\b|\\bpauza\\b")],
    status: "SUPPORTED",
    maps_to: "node delay",
    message: "Kechiktirish delay blokiga aylanadi (1 daqiqadan 7 kungacha).",
    suggestion: "24 soatdan keyin xabar yuborilmaydi (Meta qoidasi) — uzun kutish bekor bo'lishi mumkin.",
  },
  {
    key: "smart_delay_time_of_day",
    category: "node",
    label: "Smart Delay: aniq vaqtgacha kutish",
    patterns: [re("wait\\s+until\\s+(?:\\d|a\\s+specific|the\\s+(?:next|specific))|time\\s+of\\s+day|day\\s+of\\s+(?:the\\s+)?week\\s+(?:and|or)\\s+time|до\\s+(?:определенного|определённого)\\s+времени|до\\s+\\d{1,2}[:.]\\d{2}|\\d{1,2}[:.]\\d{2}\\s*gacha\\s+kut\\w*|kun\\s+vaqtigacha")],
    status: "UNSUPPORTED",
    message: "«Aniq soat/kungacha kutish» (Smart Delay) yo'q: faqat daqiqalarda kechiktirish bor.",
    suggestion: "Taxminiy kechiktirishni daqiqalarda yozing yoki condition (time.hour) bilan tekshiring.",
  },
  {
    key: "tag_add",
    category: "node",
    label: "Teg qo'shish",
    patterns: [re("add\\s+(?:the\\s+)?tags?|tag(?:ged)?\\s+(?:as|with)|добав\\w*[^.\\n]{0,20}тег|тег[^.\\n]{0,20}добав\\w*|поставить\\s+тег|teg\\w*[^.\\n]{0,25}qo'sh\\w*|qo'sh\\w*[^.\\n]{0,15}teg\\w*|teg\\w*\\s+(?:bering|biriktir)\\w*")],
    status: "SUPPORTED",
    maps_to: "node tag (add)",
    message: "Teg qo'shish tag blokiga o'tadi (CRM teglari).",
    suggestion: "Teglar avval «Asosiy ma'lumotlar» bosqichida CRM'ga import qilinadi.",
  },
  {
    key: "tag_remove",
    category: "node",
    label: "Tegni olib tashlash",
    patterns: [re("remove\\s+(?:the\\s+)?tags?|teg\\w*[^.\\n]{0,25}(?:o'chir|olib\\s+tashla)\\w*|(?:o'chir\\w*|olib\\s+tashla\\w*)[^.\\n]{0,15}teg\\w*|удал\\w*[^.\\n]{0,20}тег|тег[^.\\n]{0,20}удал\\w*")],
    status: "SUPPORTED",
    maps_to: "node tag (remove)",
    message: "Tegni olib tashlash tag blokiga (remove) o'tadi.",
    suggestion: "Teg slug'i import qilingan teg bilan mos bo'lishi kerak.",
  },
  {
    key: "set_field",
    category: "node",
    label: "Maydonni o'rnatish (Set Custom Field)",
    patterns: [re("set\\s+custom\\s+field|custom\\s+(?:user\\s+)?fields?|set\\s+(?:a\\s+)?(?:bot\\s+)?field|пользовательск\\w*\\s+пол\\w*|установ\\w*\\s+пол\\w*|maxsus\\s+maydon\\w*|maydon\\w*\\s+(?:qo'y|belgila|yoz|o'rnat)\\w*")],
    status: "SUPPORTED",
    maps_to: "node action (set_variable) / contact.customFields",
    message: "Maydon qiymatini o'rnatish action (set_variable) blokiga aylanadi.",
    suggestion: "Maydon kalitlari snake_case ko'rinishida vars.<kalit> bo'ladi.",
  },
  {
    key: "user_input",
    category: "node",
    label: "Foydalanuvchi javobini kutish (User Input)",
    patterns: [re("user\\s+input|collect\\s+(?:an?\\s+)?(?:phone|email|answer|response)|(?:phone|email)\\s+(?:number\\s+)?validation|ввод\\s+пользовател\\w*|валидац\\w*|validatsiya\\w*|foydalanuvchi\\s+kiritma\\w*|(?:telefon|raqam|email|pochta)\\w*\\s+so'ra\\w*")],
    status: "PARTIAL",
    maps_to: "node button (kind phone/email) yoki ai ask",
    message: "Javob kutish va tekshirish (validatsiya) qisman: telefon / email tugmasi yoki AI so'rovi orqali bajariladi.",
    suggestion: "Matn, son va ro'yxat tekshiruvlari uchun AI ask (extract) blokini ishlating.",
  },
  {
    key: "notify_admin",
    category: "node",
    label: "Adminga xabar",
    patterns: [re("notify\\s+(?:the\\s+)?(?:admin|team)|admin\\s+notification|уведом\\w*\\s+(?:админ|менеджер|команд)\\w*|admin(?:ga|istratorga)\\s+(?:xabar|bildirish)\\w*|menejerga\\s+(?:xabar|bildirish)\\w*|xabarnoma")],
    status: "SUPPORTED",
    maps_to: "node action (notify_telegram)",
    message: "Adminga xabar Telegram bildirishnomasi (action notify_telegram) bo'ladi.",
    suggestion: "Telegram integratsiyasi ulangan bo'lishi kerak.",
  },
  {
    key: "sequence",
    category: "node",
    label: "Sequence (drip ketma-ketlik)",
    patterns: [re("sequences?|\\bdrip\\b|последовательност\\w*|ketma-?ketlik\\w*|seriya\\w*\\s+xabar\\w*")],
    status: "UNSUPPORTED",
    message: "Sequence (drip) yo'q: obuna bo'lish / chiqish qadamlari ko'chirilmaydi.",
    suggestion: "Sequence xabarlarini Flow ichida delay → message zanjiri qilib yozing (24 soatlik oyna ichida) yoki CRM kuzatuv (follow-up) qadamlaridan foydalaning.",
  },
  {
    key: "go_to_flow",
    category: "node",
    label: "Boshqa oqimga o'tish",
    patterns: [re("go\\s+to\\s+(?:another\\s+)?flow|start\\s+(?:another|a\\s+new)\\s+flow|run\\s+(?:another\\s+)?flow|jump\\s+to\\s+(?:a\\s+)?flow|перейти\\s+(?:к|в)\\s+(?:другому\\s+)?(?:flow|поток\\w*)|запустить\\s+(?:другой\\s+)?(?:flow|поток)|boshqa\\s+(?:flow|oqim)\\w*|(?:flow|oqim)(?:ga|ni)\\s+(?:o'tish|o'ting|ishga\\s+tushir)\\w*")],
    status: "UNSUPPORTED",
    message: "Oqimdan boshqa oqimni ishga tushirish yo'q.",
    suggestion: "Bog'liq oqimlarni bitta oqimga birlashtiring yoki ikkinchisini alohida trigger bilan ishga tushiring.",
  },
  {
    key: "live_chat",
    category: "node",
    label: "Operatorga ulash (Live Chat)",
    patterns: [re("live\\s*chat|human\\s+(?:takeover|handoff|agent)|talk\\s+to\\s+(?:a\\s+)?human|живо\\w*\\s+чат\\w*|оператор\\w*|передать\\s+(?:менеджер|человек)\\w*|operator\\w*|jonli\\s+(?:suhbat|chat)\\w*|odam\\s+bilan\\s+gaplash\\w*|menejerga\\s+ulash\\w*")],
    status: "SUPPORTED",
    maps_to: "node operator",
    message: "Live Chat / operatorga o'tkazish operator blokiga aylanadi.",
    suggestion: "Sabab (wants_human / complaint / purchase_ready) ni to'g'ri tanlang.",
  },
  {
    key: "stop_automation",
    category: "node",
    label: "Avtomatizatsiyani to'xtatish",
    patterns: [re("stop\\s+(?:automation|bot|follow-?ups?)|unsubscribe|отписа\\w*|остановить\\s+автоматизац\\w*|avtomatizatsiyani\\s+to'xtat\\w*|obunani\\s+bekor\\w*")],
    status: "SUPPORTED",
    maps_to: "node action (opt_out / stop_followups)",
    message: "To'xtatish / obunani bekor qilish action (opt_out, stop_followups) blokiga o'tadi.",
    suggestion: "Bu mijozga keyingi xabarlar yuborilmasligini tekshiring.",
  },
  {
    key: "ai_step",
    category: "node",
    label: "ManyChat AI qadami",
    patterns: [re("manychat\\s+ai|ai\\s+(?:step|agent|assistant|block|reply)|chat\\s*gpt|\\bgpt\\b|(?<![а-яё])ии(?![а-яё])|нейро\\w*|искусственн\\w*\\s+интеллект\\w*|sun'iy\\s+intellekt\\w*")],
    status: "UNSUPPORTED",
    maps_to: "node ai (takeover) — JavobAI",
    message: "ManyChat AI qadamlari ko'chmaydi: ularning o'rnini JavobAI egallaydi.",
    suggestion: "AI qadamini «ai takeover» blokiga almashtiring va JavobAI ni LIVE rejimga o'tkazing (bilimlar bazasini to'ldiring).",
  },
  {
    key: "external_request",
    category: "node",
    label: "Tashqi so'rov (External Request)",
    patterns: [re("external\\s+request|http\\s+request|\\bwebhook\\b|api\\s+(?:call|request)|внешн\\w*\\s+запрос\\w*|http[-\\s]запрос\\w*|вебхук\\w*|tashqi\\s+so'rov\\w*|vebhuk\\w*|webhuk\\w*")],
    status: "PARTIAL",
    maps_to: "node webhook (faqat POST)",
    message: "External Request qisman: faqat POST so'rovli webhook bloki bor (https, ochiq internet).",
    suggestion: "GET so'rovlar va maxsus sarlavhalarni qo'llab bo'lmaydi; zarur bo'lsa Integratsiyalar 2.0 dan foydalaning.",
  },
  {
    key: "zapier_make",
    category: "node",
    label: "Zapier / Make integratsiyasi",
    patterns: [re("zapier|make\\.com|integromat|\\bmake\\s+(?:scenario|integration|webhook)|\\bn8n\\b")],
    status: "UNSUPPORTED",
    message: "Zapier / Make qadami oqim ichida yo'q.",
    suggestion: "Oqimda webhook blokidan yoki Integratsiyalar 2.0 (Zapier / Make ulagichlari, voqealar) dan foydalaning.",
  },
  {
    key: "payment",
    category: "node",
    label: "To'lov (Payments)",
    patterns: [re("\\bpayments?\\b|stripe|paypal|\\bpayme\\b|\\buzum\\b|checkout|invoice|оплат\\w*|платёж\\w*|платеж\\w*|to'lov\\w*|tolov\\w*")],
    status: "UNSUPPORTED",
    message: "Oqim ichida to'lov qabul qilish yo'q.",
    suggestion: "To'lov havolasini (Payme / Click / Uzum) matnda yuboring yoki operatorga o'tkazing; lead CRM'da kuzatiladi.",
  },
  {
    key: "send_email",
    category: "node",
    label: "Email yuborish",
    patterns: [re("send\\s+(?:an?\\s+)?e-?mail|e-?mail\\s+(?:step|message|campaign)|отправ\\w*\\s+(?:письмо|email|e-mail)|email\\s+yubor\\w*|pochta(?:ga)?\\s+xabar\\w*|elektron\\s+pochta\\w*\\s+yubor\\w*")],
    status: "UNSUPPORTED",
    message: "Email yuborish qadami yo'q.",
    suggestion: "Emailni lead sifatida yig'ib, adminga Telegram xabarnomasi yuboring yoki CRM orqali bog'laning.",
  },
  {
    key: "randomizer",
    category: "node",
    label: "Randomizer / A-B test",
    patterns: [re("randomi[sz]er|random\\s+(?:split|path)|a\\/b\\s+test|split\\s+test|рандомайзер|случайн\\w*\\s+(?:выбор|ветк)\\w*|tasodifiy\\s+(?:tanlov|yo'l)\\w*|randomayzer")],
    status: "UNSUPPORTED",
    severity: "warning",
    message: "Randomizer / A-B split yo'q.",
    suggestion: "Bitta variantni tanlang yoki ikkita alohida oqim yarating va natijalarni Analitika'da solishtiring.",
  },

  // ─── Channels ──────────────────────────────────────────────────────────────
  {
    key: "channel_messenger",
    category: "channel",
    label: "Facebook Messenger",
    patterns: [re("\\bmessenger\\b|\\bfacebook\\b|фейсбук\\w*|фэйсбук\\w*")],
    status: "UNSUPPORTED",
    message: "Facebook Messenger kanali qo'llab-quvvatlanmaydi — SocialAuto faqat Instagram.",
    suggestion: "Messenger qismini Instagram Direct bilan almashtiring yoki alohida qoldiring.",
  },
  {
    key: "channel_whatsapp",
    category: "channel",
    label: "WhatsApp",
    patterns: [re("whats\\s*app|ватсап\\w*|вотсап\\w*|вацап\\w*|vatsap\\w*|watsap\\w*")],
    status: "UNSUPPORTED",
    message: "WhatsApp kanali qo'llab-quvvatlanmaydi.",
    suggestion: "WhatsApp qismi ko'chirilmaydi; mijozni Instagram Direct ga yo'naltiring yoki WhatsApp raqamini matnda yozing.",
  },
  {
    key: "channel_telegram",
    category: "channel",
    label: "Telegram kanali",
    patterns: [re("telegram|телеграм\\w*")],
    status: "UNSUPPORTED",
    severity: "warning",
    message: "Telegram mijoz kanali sifatida qo'llab-quvvatlanmaydi (admin bildirishnomalari bundan mustasno).",
    suggestion: "Telegram faqat adminga xabarnoma uchun ishlatiladi (action notify_telegram).",
  },
  {
    key: "channel_sms",
    category: "channel",
    label: "SMS",
    patterns: [re("\\bsms\\b|смс")],
    status: "UNSUPPORTED",
    message: "SMS kanali qo'llab-quvvatlanmaydi.",
    suggestion: "Telefon raqamini lead sifatida yig'ib, menejer qo'ng'iroq / SMS qilsin.",
  },

  // ─── Features outside flows ────────────────────────────────────────────────
  {
    key: "broadcast",
    category: "feature",
    label: "Broadcast / OTN",
    patterns: [re("broadcasts?|one[-\\s]time\\s+notification|\\botn\\b|recurring\\s+notifications?|рассылк\\w*|ommaviy\\s+xabar\\w*|rassilka\\w*")],
    status: "UNSUPPORTED",
    message: "Broadcast, OTN va takroriy bildirishnomalar Flow ichida yo'q.",
    suggestion: "CRM → Broadcast ishlating: faqat 24 soatlik oyna ichida va ro'yxat bo'yicha segmentlangan holda yuboriladi.",
  },
  {
    key: "ice_breakers",
    category: "feature",
    label: "Ice breakers / doimiy menyu",
    patterns: [re("ice\\s*breakers?|persistent\\s+menu|постоянн\\w*\\s+меню|doimiy\\s+menyu\\w*")],
    status: "UNSUPPORTED",
    severity: "warning",
    message: "Ice breakers va doimiy menyu (persistent menu) qo'llab-quvvatlanmaydi.",
    suggestion: "Instagram profilida savol tugmalarini qo'lda sozlang va ularga kalit so'zli Direct trigger yarating.",
  },
];

const BY_KEY = new Map(FEATURE_CATALOG.map((entry) => [entry.key, entry]));

export function catalogEntry(key: string): CatalogEntry | undefined {
  return BY_KEY.get(key);
}

export function defaultSeverity(status: FeatureStatus): FindingSeverity {
  return status === "UNSUPPORTED" ? "error" : status === "PARTIAL" ? "warning" : "info";
}

/** Normalises apostrophes / quotes so patterns can use a plain "'". */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[ʻʼ’‘`´ʹ]/g, "'")
    .replace(/\r\n?/g, "\n");
}
