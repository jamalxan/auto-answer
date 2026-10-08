/**
 * Strings for the lead assistant, leads and integrations area. Kept in its own
 * module (and spread into each locale dictionary as `assistant`) so the three
 * large locale files stay manageable. Uzbek (Latin) and Russian are first-class;
 * English mirrors them.
 */

export interface AssistantDictionary {
  nav: { assistant: string; leads: string; integrations: string };
  tokenBanner: { title: string; body: (usernames: string) => string; cta: string };
  tokenStatus: { active: string; broken: string; brokenHelp: string };
  campaignToggle: string;
  campaignToggleHelp: string;
  usage: { aiConversations: string; aiConversationsHelp: string };
  common: {
    save: string;
    saving: string;
    saved: string;
    cancel: string;
    delete: string;
    add: string;
    remove: string;
    copy: string;
    copied: string;
    loading: string;
    loadError: string;
    all: string;
    optional: string;
    close: string;
    refresh: string;
    readOnly: string;
    confirm: string;
  };
  assistant: {
    title: string;
    subtitle: string;
    statusOn: string;
    statusOff: string;
    statusDraft: string;
    statusDraftHelp: string;
    enable: string;
    disable: string;
    approve: string;
    approving: string;
    approvedOn: (date: string) => string;
    fromTelegram: (date: string) => string;
    accountScope: string;
    allAccounts: string;
    steps: { autofill: string; edit: string; test: string };
    autofill: {
      title: string;
      help: string;
      websiteLabel: string;
      websitePlaceholder: string;
      run: string;
      running: string;
      done: string;
      errors: Record<string, string>;
      telegramTitle: string;
      telegramHelp: string;
      telegramBtn: string;
      telegramError: string;
      skipToEdit: string;
    };
    profile: {
      company: string;
      description: string;
      descriptionHelp: string;
      categories: string;
      categoriesHelp: string;
      categoryName: string;
      categoryNote: string;
      products: string;
      productsHelp: string;
      productName: string;
      productPrice: string;
      productFrom: string;
      noPrice: string;
      bulkTitle: string;
      bulkPlaceholder: string;
      bulkApply: string;
      pricePolicy: string;
      policyNever: string;
      policyFrom: string;
      policyExact: string;
      policyHelp: string;
      tone: string;
      toneFriendly: string;
      toneFormal: string;
      persona: string;
      personaHelp: string;
      extraField: string;
      extraFieldHelp: string;
      finalMessage: string;
      finalMessageHelp: string;
      address: string;
      delivery: string;
      workingHours: string;
      payments: string;
      faqs: string;
      faqsHelp: string;
      faqQuestion: string;
      faqAnswer: string;
      counter: (used: number, max: number) => string;
      tooLong: string;
      instructionWarning: string;
      requiredMissing: string;
      productLimit: string;
    };
    rules: {
      title: string;
      campaignReplies: string;
      inboundDm: string;
      operatorPause: string;
      operatorPauseHelp: string;
      maxMessages: string;
      fallbackLead: string;
      postHandoff: string;
      hoursFilter: string;
      hoursFilterHelp: string;
      from: string;
      to: string;
      days: string[];
      offHoursMessage: string;
      priceReminder: string;
    };
    sandbox: {
      title: string;
      help: string;
      placeholder: string;
      send: string;
      reset: string;
      thinking: string;
      leadCreated: (summary: string) => string;
      blocked: string;
      saveFirst: string;
      noLlm: string;
      empty: string;
    };
    gaps: {
      title: string;
      help: string;
      empty: string;
      hits: (n: number) => string;
      answerPlaceholder: string;
      answer: string;
      ignore: string;
    };
    changes: { title: string; empty: string; panel: string; telegram: string };
    errors: { save: string; approve: string; incomplete: string; notApproved: string };
  };
  leads: {
    title: string;
    subtitle: string;
    export: string;
    searchPlaceholder: string;
    allStatuses: string;
    allSources: string;
    from: string;
    to: string;
    status: Record<string, string>;
    source: Record<string, string>;
    columns: { date: string; name: string; phone: string; username: string; interest: string; source: string; delivery: string; actions: string };
    copyPhone: string;
    openChat: string;
    details: string;
    redeliver: string;
    redelivering: string;
    redeliverQueued: (n: number) => string;
    empty: string;
    emptyHelp: string;
    repeat: string;
    test: string;
    noPhone: string;
    complaint: string;
    contacted: string;
    page: (page: number, pages: number) => string;
    prev: string;
    next: string;
    detail: {
      summary: string;
      transcript: string;
      deliveries: string;
      attempts: (n: number) => string;
      openInCrm: string;
      campaign: string;
      keyword: string;
      tracked: string;
      trackedYes: string;
      noDeliveries: string;
      repeatNote: (n: number) => string;
      nextAttempt: (date: string) => string;
    };
    delivery: Record<string, string>;
  };
  integrations: {
    title: string;
    subtitle: string;
    status: Record<string, string>;
    notConnected: string;
    connect: string;
    reconnect: string;
    check: string;
    checking: string;
    checkOk: string;
    checkFailed: string;
    testLead: string;
    testSent: string;
    disconnect: string;
    confirmDelete: string;
    save: string;
    lastChecked: (date: string) => string;
    lastError: string;
    pending: (n: number) => string;
    dead: (n: number) => string;
    accountFilter: string;
    accountFilterHelp: string;
    memberReadOnly: string;
    botNotConfigured: string;
    brokenBanner: (name: string) => string;
    steps: string;
    tokenExpires: (date: string) => string;
    disable: string;
    enable: string;
    errors: Record<string, string>;
    telegram: {
      name: string;
      desc: string;
      privateBtn: string;
      groupBtn: string;
      chats: string;
      noChats: string;
      codeHelp: string;
      steps: string[];
    };
    amocrm: {
      name: string;
      desc: string;
      subdomain: string;
      zone: string;
      token: string;
      tokenExpiresAt: string;
      tokenExpiresHelp: string;
      pipeline: string;
      stage: string;
      responsible: string;
      noneOption: string;
      campaignTag: string;
      nameTemplate: string;
      nameTemplateHelp: string;
      igField: string;
      loadOptions: string;
      steps: string[];
    };
    bitrix: {
      name: string;
      desc: string;
      webhookUrl: string;
      webhookHelp: string;
      responsible: string;
      source: string;
      loadOptions: string;
      steps: string[];
    };
  };
  dashboard: {
    leadsPeriod: string;
    conversion: string;
    conversionHelp: string;
    undelivered: string;
    undeliveredHelp: string;
    last30: string;
  };
  inbox: {
    badgeAssistant: string;
    badgeOperator: string;
    badgeLead: string;
    pause: string;
    resume: string;
    leadPanel: string;
    name: string;
    phone: string;
    interest: string;
    campaign: string;
    crm: string;
    operatorUntil: (date: string) => string;
    pausedNote: string;
  };
  diagnostics: {
    deliveryErrors: string;
    deliveryErrorsEmpty: string;
    integrationHealth: string;
    integrationHealthEmpty: string;
    llmHealth: string;
    templateMode: (until: string) => string;
    llmOk: string;
    llmNotConfigured: string;
    llmErrors: (n: number) => string;
    blockedReplies: (n: number) => string;
    aiUsage: (used: number, limit: number) => string;
    cost: (usd: string) => string;
  };
}

export const assistantUz: AssistantDictionary = {
  nav: { assistant: "Assistent", leads: "Lidlar", integrations: "Integratsiyalar" },
  tokenBanner: {
    title: "Instagram ulanishi uzilgan",
    body: (u) => `${u} uchun Meta tokenni rad etdi — kampaniyalar va assistent ishlamayapti. Akkauntni qayta ulang.`,
    cta: "Qayta ulash",
  },
  tokenStatus: { active: "Ulangan", broken: "Uzilgan", brokenHelp: "Meta tokenni rad etdi. Akkauntni qayta ulang." },
  campaignToggle: "Javob berganlarni assistentga topshirish",
  campaignToggleHelp:
    "Mijoz kampaniya DM'iga javob yozsa, lid yig'uvchi assistent suhbatni davom ettiradi: ism va telefonni so'raydi, lidni Telegram/CRM'ga yuboradi. Assistent Assistent sahifasida yoqilgan va tasdiqlangan bo'lishi kerak.",
  usage: {
    aiConversations: "AI suhbatlar (shu oy)",
    aiConversationsHelp: "Limit tugasa assistent zaxira shablonlariga o'tadi, raqam yig'ish to'xtamaydi.",
  },
  common: {
    save: "Saqlash",
    saving: "Saqlanmoqda…",
    saved: "Saqlandi",
    cancel: "Bekor qilish",
    delete: "O'chirish",
    add: "Qo'shish",
    remove: "Olib tashlash",
    copy: "Nusxalash",
    copied: "Nusxalandi",
    loading: "Yuklanmoqda…",
    loadError: "Yuklab bo'lmadi",
    all: "Hammasi",
    optional: "ixtiyoriy",
    close: "Yopish",
    refresh: "Yangilash",
    readOnly: "Faqat ko'rish: o'zgartirish uchun owner yoki admin kerak.",
    confirm: "Tasdiqlash",
  },
  assistant: {
    title: "Lid yig'uvchi assistent",
    subtitle: "Instagram DM'da mijozdan nima kerakligini, ismini va telefonini oladi, lidni Telegram/CRM'ga yuboradi va suhbatni operatorga topshiradi.",
    statusOn: "Assistent yoqilgan",
    statusOff: "Assistent o'chirilgan",
    statusDraft: "Profil tasdiqlanmagan",
    statusDraftHelp: "Tasdiqlanmagan profil bilan assistent yoqilmaydi. Profilni to'ldiring, sinab ko'ring va tasdiqlang.",
    enable: "Yoqish",
    disable: "O'chirish",
    approve: "Tasdiqlash va yoqish",
    approving: "Tasdiqlanmoqda…",
    approvedOn: (d) => `Tasdiqlangan: ${d}`,
    fromTelegram: (d) => `Telegram orqali to'ldirildi, ${d}`,
    accountScope: "Qaysi akkaunt uchun",
    allAccounts: "Barcha akkauntlar",
    steps: { autofill: "1. Avto-to'ldirish", edit: "2. Tahrirlash", test: "3. Sinov chati" },
    autofill: {
      title: "Qoralama tuzish",
      help: "Instagram bio, oxirgi postlar va (ixtiyoriy) sayt matnidan qoralama profil tuziladi. Siz uni ko'rib chiqib, tahrirlab, tasdiqlaysiz.",
      websiteLabel: "Sayt manzili (ixtiyoriy)",
      websitePlaceholder: "https://kompaniya.uz",
      run: "Qoralama tuzish",
      running: "Tuzilmoqda…",
      done: "Qoralama tayyor — 2-qadamda tekshiring.",
      errors: {
        bad_url: "Sayt manzili noto'g'ri.",
        private_address: "Bu manzilga murojaat qilib bo'lmaydi.",
        fetch_failed: "Saytni o'qib bo'lmadi.",
        no_llm: "AI provayder sozlanmagan (LLM_PROVIDER, LLM_API_KEY).",
        token_expired: "Instagram ulanishi uzilgan. Akkauntni qayta ulang.",
        autofill_failed: "Qoralama tuzib bo'lmadi. Keyinroq urinib ko'ring.",
      },
      telegramTitle: "Telegram orqali to'ldirish",
      telegramHelp: "Ovozli xabar, narxlar rasmi yoki Excel yuboring — bot savollar beradi. 10 daqiqa yetadi.",
      telegramBtn: "Telegram orqali to'ldirish",
      telegramError: "Telegram bot sozlanmagan.",
      skipToEdit: "Qo'lda to'ldiraman",
    },
    profile: {
      company: "Kompaniya nomi",
      description: "Qisqa tavsif",
      descriptionHelp: "Nima bilan shug'ullanasiz? 1–3 gap.",
      categories: "Mahsulot/xizmat kategoriyalari",
      categoriesHelp: "Masalan: «Divanlar — burchakli, to'g'ri, yotoqli».",
      categoryName: "Kategoriya",
      categoryNote: "Izoh (1 qator)",
      products: "Mahsulotlar va narxlar",
      productsHelp: "Narx faqat narx siyosati «aytilsin» bo'lsa ishlatiladi. Narxsiz mahsulot uchun assistent «menejer aytadi» deydi.",
      productName: "Nomi",
      productPrice: "Narx (so'm)",
      productFrom: "dan",
      noPrice: "narxsiz",
      bulkTitle: "Ro'yxatni qo'yish",
      bulkPlaceholder: "Burchakli divan Milan — 4 500 000\nKreslo — 1,2 mln\nStol — 300 ming",
      bulkApply: "Ro'yxatni qo'shish",
      pricePolicy: "Narx siyosati",
      policyNever: "Narx aytilmaydi (menejer aytadi)",
      policyFrom: "«...dan boshlab» deb aytilsin",
      policyExact: "Ro'yxatdagi aniq narx aytilsin",
      policyHelp: "Assistent faqat ro'yxatdagi narxni aytadi — hisoblamaydi, chegirma bermaydi.",
      tone: "Ohang",
      toneFriendly: "Samimiy",
      toneFormal: "Rasmiy",
      persona: "Assistent ismi",
      personaHelp: "Bo'sh qolsa «kompaniya yordamchisi». Mijoz so'rasa, u assistent ekanini aytadi.",
      extraField: "Raqamdan tashqari so'raladigan maydon",
      extraFieldHelp: "Ko'pi bilan bitta (masalan «Shahar»). Maqsad — raqam.",
      finalMessage: "Yakuniy xabar shabloni",
      finalMessageHelp: "{name} va {phone} o'rniga mijoz ma'lumotlari qo'yiladi.",
      address: "Manzil / filiallar",
      delivery: "Yetkazib berish",
      workingHours: "Ish vaqti",
      payments: "To'lov usullari",
      faqs: "Tez-tez beriladigan savollar",
      faqsHelp: "5 tagacha savol va qisqa javob.",
      faqQuestion: "Savol",
      faqAnswer: "Javob",
      counter: (u, m) => `${u} / ${m} belgi`,
      tooLong: "Profil matni 6 000 belgidan oshmasligi kerak.",
      instructionWarning: "Matnda assistentga ko'rsatma o'xshash jumlalar bor. Assistent baribir o'z qat'iy qoidalariga amal qiladi.",
      requiredMissing: "Kompaniya nomi, tavsif va kamida bitta mahsulot yoki kategoriya kerak.",
      productLimit: "Ko'pi bilan 200 ta mahsulot.",
    },
    rules: {
      title: "Qoidalar",
      campaignReplies: "Kampaniya DM'iga javob berganlarga assistent javob bersin",
      inboundDm: "Kiruvchi DM'larga assistent javob bersin",
      operatorPause: "Operator yozgach bot jim turadi (soat)",
      operatorPauseHelp: "Operator Instagram ilovasidan yoki Xabarlar sahifasidan yozsa.",
      maxMessages: "Bir suhbatda bot xabarlari limiti",
      fallbackLead: "Raqam bermagan mijozni ham «raqamsiz lid» sifatida yuborish",
      postHandoff: "Raqam olingandan keyin mijoz yana yozsa, savoliga qisqa javob berib, batafsilini menejer aytishini bildirsin (ko'pi bilan 3 marta)",
      hoursFilter: "Faqat ish vaqtida javob bersin",
      hoursFilterHelp: "Ish vaqtidan tashqarida maxsus matn bilan baribir raqam so'raladi.",
      from: "Boshlanishi",
      to: "Tugashi",
      days: ["Yak", "Du", "Se", "Chor", "Pay", "Ju", "Sha"],
      offHoursMessage: "Ish vaqtidan tashqari matn",
      priceReminder: "Narxlar 30 kun o'zgarmasa, Telegram'da eslatilsin",
    },
    sandbox: {
      title: "Sinov chati",
      help: "Siz mijozsiz. Assistent Instagram'dagi bilan aynan bir xil mantiqda javob beradi; Instagram'ga hech narsa yuborilmaydi.",
      placeholder: "Mijoz xabari…",
      send: "Yuborish",
      reset: "Qaytadan boshlash",
      thinking: "Yozmoqda…",
      leadCreated: (s) => `📥 Lid yaratilgan bo'lardi. ${s}`,
      blocked: "Filtr bu javobni bloklab, shablon yubordi.",
      saveFirst: "Avval profilni saqlang.",
      noLlm: "AI provayder sozlanmagan, sinov chati ishlamaydi.",
      empty: "Birinchi xabarni yozing, masalan «Salom, divan bormi?»",
    },
    gaps: {
      title: "Javobsiz savollar",
      help: "Assistent «menejer aytadi» deb javob bergan savollar. Javob bersangiz, u FAQ'ga qo'shiladi.",
      empty: "Hozircha javobsiz savol yo'q.",
      hits: (n) => `${n} marta`,
      answerPlaceholder: "Javobingiz…",
      answer: "Javob berish",
      ignore: "E'tiborsiz qoldirish",
    },
    changes: { title: "O'zgarishlar tarixi", empty: "O'zgarishlar yo'q.", panel: "panel", telegram: "Telegram" },
    errors: {
      save: "Saqlab bo'lmadi.",
      approve: "Tasdiqlab bo'lmadi.",
      incomplete: "Profil to'liq emas: kompaniya nomi, tavsif va kamida bitta mahsulot yoki kategoriya kerak.",
      notApproved: "Avval profilni tasdiqlang.",
    },
  },
  leads: {
    title: "Lidlar",
    subtitle: "Assistent yoki raqam yozgan mijozlardan yig'ilgan lidlar va ularning Telegram/CRM'ga yetkazilishi.",
    export: "CSV yuklab olish",
    searchPlaceholder: "Ism, telefon, @username, qiziqish",
    allStatuses: "Barcha holatlar",
    allSources: "Barcha manbalar",
    from: "Dan",
    to: "Gacha",
    status: { NEW: "Yangi", SENT: "Yuborilgan", PARTIAL: "Qisman", FAILED: "Xato" },
    source: { CAMPAIGN: "Kampaniya", INBOUND_DM: "Kiruvchi DM" },
    columns: { date: "Sana", name: "Ism", phone: "Telefon", username: "Instagram", interest: "Qiziqish", source: "Manba", delivery: "Yetkazish", actions: "Amallar" },
    copyPhone: "Raqamni nusxalash",
    openChat: "Suhbat",
    details: "Batafsil",
    redeliver: "Qayta yuborish",
    redelivering: "Yuborilmoqda…",
    redeliverQueued: (n) => `${n} ta yetkazish navbatga qo'yildi`,
    empty: "Hali lid yo'q",
    emptyHelp: "Assistentni yoqing yoki kampaniyada mijozlar raqam yozishini kuting — lidlar shu yerda paydo bo'ladi.",
    repeat: "Takroriy",
    test: "TEST",
    noPhone: "raqamsiz",
    complaint: "shikoyat",
    contacted: "Bog'lanildi",
    page: (p, n) => `${p} / ${n}`,
    prev: "Oldingi",
    next: "Keyingi",
    detail: {
      summary: "Xulosa",
      transcript: "Suhbat yozuvi",
      deliveries: "Yetkazish tarixi",
      attempts: (n) => `${n} urinish`,
      openInCrm: "CRM'da ochish",
      campaign: "Kampaniya",
      keyword: "Kalit so'z",
      tracked: "Havola",
      trackedYes: "bosilgan",
      noDeliveries: "Faol integratsiya yo'q edi.",
      repeatNote: (n) => `Bu mijoz 30 kun ichida ${n} marta murojaat qilgan.`,
      nextAttempt: (d) => `keyingi urinish: ${d}`,
    },
    delivery: { PENDING: "Kutilmoqda", SENT: "Yuborildi", FAILED: "Qayta uriniladi", DEAD: "Yetkazilmadi", TELEGRAM: "Telegram", AMOCRM: "amoCRM", BITRIX24: "Bitrix24" },
  },
  integrations: {
    title: "Integratsiyalar",
    subtitle: "Lidlar qayerga yuborilishini tanlang. Har bir integratsiya mustaqil ishlaydi: biri xato bersa, boshqalariga ta'sir qilmaydi.",
    status: { ACTIVE: "Faol", BROKEN: "Uzilgan", DISABLED: "O'chirilgan" },
    notConnected: "Ulanmagan",
    connect: "Ulash",
    reconnect: "Qayta ulash",
    check: "Ulanishni tekshirish",
    checking: "Tekshirilmoqda…",
    checkOk: "Ulanish ishlayapti",
    checkFailed: "Ulanish ishlamayapti",
    testLead: "Test lid yuborish",
    testSent: "Test lid yuborildi — natijani Lidlar sahifasida ko'ring.",
    disconnect: "Uzish",
    confirmDelete: "Integratsiya o'chirilsinmi? Yuborilmagan lidlar yo'qoladi.",
    save: "Saqlash",
    lastChecked: (d) => `Tekshirilgan: ${d}`,
    lastError: "Oxirgi xato",
    pending: (n) => `${n} ta lid kutmoqda`,
    dead: (n) => `${n} ta lid yetkazilmadi`,
    accountFilter: "Qaysi Instagram akkauntlar lidlari",
    accountFilterHelp: "Hech narsa tanlanmasa — hamma akkauntlar. Agentliklar uchun: A mijoz akkaunti → A ning CRM'i.",
    memberReadOnly: "Integratsiyalarni faqat owner yoki admin o'zgartira oladi.",
    botNotConfigured: "Platforma Telegram boti sozlanmagan (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME).",
    brokenBanner: (n) => `${n} ulanishi uzildi, qayta ulang. Lidlar Telegram'ga yetkazilishda davom etadi, tiklangach CRM'ga avtomatik yuboriladi.`,
    steps: "Qadamlar",
    tokenExpires: (d) => `Token muddati: ${d}`,
    disable: "O'chirib qo'yish",
    enable: "Yoqish",
    errors: {
      invalid_token: "Token yaroqsiz yoki ruxsati yetarli emas.",
      invalid_webhook: "Webhook yaroqsiz yoki ruxsati yetarli emas.",
      invalid_webhook_url: "Webhook manzili noto'g'ri. Ko'rinishi: https://portal.bitrix24.uz/rest/1/kod/",
      invalid_credentials: "Yangi ma'lumotlar yaroqsiz.",
      connection_failed: "Servisga ulanib bo'lmadi.",
      bot_not_configured: "Telegram bot sozlanmagan.",
      not_active: "Integratsiya faol emas — avval ulanishni tekshiring.",
      generic: "Xatolik yuz berdi.",
    },
    telegram: {
      name: "Telegram",
      desc: "Yangi lidlar guruhga yoki shaxsiy chatga xabar bo'lib keladi, «Bog'lanildi» tugmasi bilan.",
      privateBtn: "Shaxsiy chatga ulash",
      groupBtn: "Guruhga qo'shish",
      chats: "Ulangan chatlar",
      noChats: "Hali chat ulanmagan.",
      codeHelp: "Havola 15 daqiqa amal qiladi va bir marta ishlaydi.",
      steps: [
        "«Shaxsiy chatga ulash» yoki «Guruhga qo'shish» tugmasini bosing.",
        "Telegram ochiladi — botda START ni bosing (guruhda botni qo'shishni tasdiqlang).",
        "Bot «Ulandi» deb yozadi. Bir nechta chat ulash mumkin.",
        "«Test lid yuborish» bilan tekshiring.",
      ],
    },
    amocrm: {
      name: "amoCRM",
      desc: "Har bir lid uchun yangi kontakt (ism + telefon) va yangi lid yaratiladi; mijoz ma'lumotlari va suhbat yozuvi izoh sifatida qo'shiladi.",
      subdomain: "Subdomen",
      zone: "Domen zonasi",
      token: "Uzoq muddatli token",
      tokenExpiresAt: "Token amal qilish muddati",
      tokenExpiresHelp: "Tugashiga 14 va 3 kun qolganda ogohlantiramiz.",
      pipeline: "Voronka",
      stage: "Bosqich",
      responsible: "Mas'ul xodim",
      noneOption: "— tanlanmagan —",
      campaignTag: "Kampaniya nomini teg sifatida qo'shish",
      nameTemplate: "Lid nomi shabloni",
      nameTemplateHelp: "{name}, {product_interest}, {username}",
      igField: "Instagram username maydoni (kontakt)",
      loadOptions: "Voronka va xodimlarni yuklash",
      steps: [
        "amoCRM → Sozlamalar → Integratsiyalar → «Integratsiya yaratish» → shaxsiy (ichki) integratsiya.",
        "«Kalitlar va ruxsatlar» bo'limida «Uzoq muddatli token» yarating (CRM, kontaktlar, lidlar ruxsati bilan) va muddatini yozib qo'ying.",
        "Subdomenni kiriting (promtchi.amocrm.ru → promtchi) va tokenni qo'ying.",
        "«Ulash»ni bosing, so'ng voronka va mas'ul xodimni tanlab, «Test lid yuborish» bilan tekshiring.",
      ],
    },
    bitrix: {
      name: "Bitrix24",
      desc: "CRM'da lid yaratiladi, suhbat yozuvi timeline izohi bo'ladi. Ochiq lid bo'lsa, yangisi ochilmaydi.",
      webhookUrl: "Kiruvchi webhook manzili",
      webhookHelp: "https://portal.bitrix24.uz/rest/1/kod/",
      responsible: "Mas'ul xodim",
      source: "Manba",
      loadOptions: "Xodim va manbalarni yuklash",
      steps: [
        "Bitrix24 → Dasturchilar resurslari → Boshqa → Kiruvchi webhook.",
        "Ruxsatlar: crm va user. Webhook manzilini nusxalang.",
        "Manzilni shu yerga qo'ying va «Ulash»ni bosing.",
        "Mas'ul xodim va manbani tanlang, «Test lid yuborish» bilan tekshiring.",
      ],
    },
  },
  dashboard: {
    leadsPeriod: "Lidlar",
    conversion: "Raqam olish konversiyasi",
    conversionHelp: "Assistent bilan suhbatlashganlardan raqam qoldirganlar ulushi",
    undelivered: "Yetkazilmagan lidlar",
    undeliveredHelp: "Telegram/CRM'ga yetib bormagan",
    last30: "Oxirgi 30 kun",
  },
  inbox: {
    badgeAssistant: "Assistent",
    badgeOperator: "Operator",
    badgeLead: "Lid olindi",
    pause: "Botni to'xtatish",
    resume: "Botni qayta yoqish",
    leadPanel: "Lid ma'lumotlari",
    name: "Ism",
    phone: "Telefon",
    interest: "Qiziqish",
    campaign: "Kampaniya",
    crm: "CRM",
    operatorUntil: (d) => `Bot ${d} gacha jim`,
    pausedNote: "Bot qo'lda to'xtatilgan",
  },
  diagnostics: {
    deliveryErrors: "Lid yetkazish xatolari",
    deliveryErrorsEmpty: "Yetkazilmagan lid yo'q.",
    integrationHealth: "Integratsiya holati",
    integrationHealthEmpty: "Integratsiya ulanmagan.",
    llmHealth: "AI / zaxira rejimi",
    templateMode: (u) => `Zaxira shablon rejimi ${u} gacha`,
    llmOk: "AI provayder ishlayapti",
    llmNotConfigured: "AI provayder sozlanmagan — assistent faqat shablonlar bilan ishlaydi",
    llmErrors: (n) => `AI xatolari (7 kun): ${n}`,
    blockedReplies: (n) => `Bloklangan javoblar (7 kun): ${n}`,
    aiUsage: (u, l) => `AI suhbatlar: ${u} / ${l}`,
    cost: (c) => `Xarajat (30 kun): $${c}`,
  },
};

export const assistantRu: AssistantDictionary = {
  nav: { assistant: "Ассистент", leads: "Лиды", integrations: "Интеграции" },
  tokenBanner: {
    title: "Подключение Instagram потеряно",
    body: (u) => `Meta отклонила токен для ${u} — кампании и ассистент не работают. Подключите аккаунт заново.`,
    cta: "Подключить заново",
  },
  tokenStatus: { active: "Подключено", broken: "Отключено", brokenHelp: "Meta отклонила токен. Подключите аккаунт заново." },
  campaignToggle: "Передавать ответивших ассистенту",
  campaignToggleHelp:
    "Если клиент отвечает на DM кампании, ассистент по сбору лидов продолжит диалог: спросит имя и телефон и отправит лид в Telegram/CRM. Ассистент должен быть включён и утверждён на странице «Ассистент».",
  usage: {
    aiConversations: "AI-диалоги (в этом месяце)",
    aiConversationsHelp: "Когда лимит исчерпан, ассистент переходит на резервные шаблоны, сбор номеров не останавливается.",
  },
  common: {
    save: "Сохранить",
    saving: "Сохранение…",
    saved: "Сохранено",
    cancel: "Отмена",
    delete: "Удалить",
    add: "Добавить",
    remove: "Убрать",
    copy: "Копировать",
    copied: "Скопировано",
    loading: "Загрузка…",
    loadError: "Не удалось загрузить",
    all: "Все",
    optional: "необязательно",
    close: "Закрыть",
    refresh: "Обновить",
    readOnly: "Только просмотр: для изменений нужна роль owner или admin.",
    confirm: "Подтвердить",
  },
  assistant: {
    title: "Ассистент по сбору лидов",
    subtitle: "В Instagram DM узнаёт, что нужно клиенту, берёт имя и телефон, отправляет лид в Telegram/CRM и передаёт диалог оператору.",
    statusOn: "Ассистент включён",
    statusOff: "Ассистент выключен",
    statusDraft: "Профиль не утверждён",
    statusDraftHelp: "С неутверждённым профилем ассистент не включится. Заполните профиль, проверьте в тестовом чате и утвердите.",
    enable: "Включить",
    disable: "Выключить",
    approve: "Утвердить и включить",
    approving: "Утверждение…",
    approvedOn: (d) => `Утверждён: ${d}`,
    fromTelegram: (d) => `Заполнено через Telegram, ${d}`,
    accountScope: "Для какого аккаунта",
    allAccounts: "Все аккаунты",
    steps: { autofill: "1. Автозаполнение", edit: "2. Правка", test: "3. Тестовый чат" },
    autofill: {
      title: "Создать черновик",
      help: "Черновик профиля собирается из bio Instagram, последних постов и (по желанию) текста сайта. Вы проверяете, правите и утверждаете.",
      websiteLabel: "Адрес сайта (необязательно)",
      websitePlaceholder: "https://company.uz",
      run: "Создать черновик",
      running: "Создаём…",
      done: "Черновик готов — проверьте на шаге 2.",
      errors: {
        bad_url: "Неверный адрес сайта.",
        private_address: "К этому адресу обращаться нельзя.",
        fetch_failed: "Не удалось прочитать сайт.",
        no_llm: "AI-провайдер не настроен (LLM_PROVIDER, LLM_API_KEY).",
        token_expired: "Подключение Instagram потеряно. Подключите аккаунт заново.",
        autofill_failed: "Не удалось создать черновик. Попробуйте позже.",
      },
      telegramTitle: "Заполнить через Telegram",
      telegramHelp: "Отправляйте голосовые, фото прайса или Excel — бот задаст вопросы. Хватит 10 минут.",
      telegramBtn: "Заполнить через Telegram",
      telegramError: "Telegram-бот не настроен.",
      skipToEdit: "Заполню вручную",
    },
    profile: {
      company: "Название компании",
      description: "Краткое описание",
      descriptionHelp: "Чем вы занимаетесь? 1–3 предложения.",
      categories: "Категории товаров/услуг",
      categoriesHelp: "Например: «Диваны — угловые, прямые, раскладные».",
      categoryName: "Категория",
      categoryNote: "Пояснение (1 строка)",
      products: "Товары и цены",
      productsHelp: "Цена используется, только если политика цен разрешает её называть. Для товара без цены ассистент скажет «менеджер уточнит».",
      productName: "Название",
      productPrice: "Цена (сум)",
      productFrom: "от",
      noPrice: "без цены",
      bulkTitle: "Вставить список",
      bulkPlaceholder: "Угловой диван Milan — 4 500 000\nКресло — 1,2 млн\nСтол — 300 тыс",
      bulkApply: "Добавить список",
      pricePolicy: "Политика цен",
      policyNever: "Цену не называть (скажет менеджер)",
      policyFrom: "Говорить «от ...»",
      policyExact: "Называть точную цену из списка",
      policyHelp: "Ассистент называет только цену из списка — не считает и не даёт скидок.",
      tone: "Тон",
      toneFriendly: "Дружелюбный",
      toneFormal: "Официальный",
      persona: "Имя ассистента",
      personaHelp: "Если пусто — «помощник компании». На вопрос клиента он скажет, что он ассистент.",
      extraField: "Дополнительное поле кроме номера",
      extraFieldHelp: "Не больше одного (например «Город»). Цель — номер.",
      finalMessage: "Шаблон финального сообщения",
      finalMessageHelp: "{name} и {phone} заменяются данными клиента.",
      address: "Адрес / филиалы",
      delivery: "Доставка",
      workingHours: "График работы",
      payments: "Способы оплаты",
      faqs: "Частые вопросы",
      faqsHelp: "До 5 вопросов с короткими ответами.",
      faqQuestion: "Вопрос",
      faqAnswer: "Ответ",
      counter: (u, m) => `${u} / ${m} симв.`,
      tooLong: "Текст профиля не должен превышать 6 000 символов.",
      instructionWarning: "В тексте есть фразы, похожие на указания для ассистента. Ассистент всё равно следует своим жёстким правилам.",
      requiredMissing: "Нужны название, описание и хотя бы один товар или категория.",
      productLimit: "Не больше 200 товаров.",
    },
    rules: {
      title: "Правила",
      campaignReplies: "Отвечать тем, кто ответил на DM кампании",
      inboundDm: "Отвечать на входящие DM",
      operatorPause: "Бот молчит после ответа оператора (часов)",
      operatorPauseHelp: "Если оператор написал из приложения Instagram или со страницы «Сообщения».",
      maxMessages: "Лимит сообщений бота в диалоге",
      fallbackLead: "Отправлять и клиентов без номера как «лид без номера»",
      postHandoff: "Если клиент пишет после передачи, кратко ответить на вопрос и сказать, что подробности даст менеджер (не более 3 раз)",
      hoursFilter: "Отвечать только в рабочее время",
      hoursFilterHelp: "Вне рабочего времени ассистент всё равно спросит номер, с особым текстом.",
      from: "С",
      to: "До",
      days: ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"],
      offHoursMessage: "Текст вне рабочего времени",
      priceReminder: "Напоминать в Telegram, если цены не менялись 30 дней",
    },
    sandbox: {
      title: "Тестовый чат",
      help: "Вы — клиент. Ассистент отвечает по той же логике, что и в Instagram; в Instagram ничего не отправляется.",
      placeholder: "Сообщение клиента…",
      send: "Отправить",
      reset: "Начать заново",
      thinking: "Печатает…",
      leadCreated: (s) => `📥 Был бы создан лид. ${s}`,
      blocked: "Фильтр заблокировал этот ответ и отправил шаблон.",
      saveFirst: "Сначала сохраните профиль.",
      noLlm: "AI-провайдер не настроен, тестовый чат не работает.",
      empty: "Напишите первое сообщение, например «Здравствуйте, есть диваны?»",
    },
    gaps: {
      title: "Вопросы без ответа",
      help: "Вопросы, на которые ассистент ответил «менеджер уточнит». Ваш ответ добавится в FAQ.",
      empty: "Пока вопросов без ответа нет.",
      hits: (n) => `${n} раз`,
      answerPlaceholder: "Ваш ответ…",
      answer: "Ответить",
      ignore: "Игнорировать",
    },
    changes: { title: "История изменений", empty: "Изменений нет.", panel: "панель", telegram: "Telegram" },
    errors: {
      save: "Не удалось сохранить.",
      approve: "Не удалось утвердить.",
      incomplete: "Профиль неполный: нужны название, описание и хотя бы один товар или категория.",
      notApproved: "Сначала утвердите профиль.",
    },
  },
  leads: {
    title: "Лиды",
    subtitle: "Лиды, собранные ассистентом или из номеров, которые клиенты написали сами, и их доставка в Telegram/CRM.",
    export: "Скачать CSV",
    searchPlaceholder: "Имя, телефон, @username, интерес",
    allStatuses: "Все статусы",
    allSources: "Все источники",
    from: "С",
    to: "По",
    status: { NEW: "Новый", SENT: "Отправлен", PARTIAL: "Частично", FAILED: "Ошибка" },
    source: { CAMPAIGN: "Кампания", INBOUND_DM: "Входящий DM" },
    columns: { date: "Дата", name: "Имя", phone: "Телефон", username: "Instagram", interest: "Интерес", source: "Источник", delivery: "Доставка", actions: "Действия" },
    copyPhone: "Копировать номер",
    openChat: "Диалог",
    details: "Подробнее",
    redeliver: "Отправить снова",
    redelivering: "Отправка…",
    redeliverQueued: (n) => `В очередь поставлено доставок: ${n}`,
    empty: "Лидов пока нет",
    emptyHelp: "Включите ассистента или дождитесь, пока клиенты кампаний напишут номер — лиды появятся здесь.",
    repeat: "Повторный",
    test: "ТЕСТ",
    noPhone: "без номера",
    complaint: "жалоба",
    contacted: "Связались",
    page: (p, n) => `${p} / ${n}`,
    prev: "Назад",
    next: "Далее",
    detail: {
      summary: "Резюме",
      transcript: "Запись диалога",
      deliveries: "История доставки",
      attempts: (n) => `попыток: ${n}`,
      openInCrm: "Открыть в CRM",
      campaign: "Кампания",
      keyword: "Ключевое слово",
      tracked: "Ссылка",
      trackedYes: "открыта",
      noDeliveries: "Активных интеграций не было.",
      repeatNote: (n) => `Клиент обращался ${n} раз за 30 дней.`,
      nextAttempt: (d) => `следующая попытка: ${d}`,
    },
    delivery: { PENDING: "Ожидает", SENT: "Отправлено", FAILED: "Повтор", DEAD: "Не доставлено", TELEGRAM: "Telegram", AMOCRM: "amoCRM", BITRIX24: "Bitrix24" },
  },
  integrations: {
    title: "Интеграции",
    subtitle: "Выберите, куда отправлять лиды. Каждая интеграция работает независимо: сбой одной не влияет на другие.",
    status: { ACTIVE: "Активна", BROKEN: "Отключена", DISABLED: "Выключена" },
    notConnected: "Не подключено",
    connect: "Подключить",
    reconnect: "Подключить заново",
    check: "Проверить подключение",
    checking: "Проверка…",
    checkOk: "Подключение работает",
    checkFailed: "Подключение не работает",
    testLead: "Отправить тестовый лид",
    testSent: "Тестовый лид отправлен — результат на странице «Лиды».",
    disconnect: "Отключить",
    confirmDelete: "Удалить интеграцию? Неотправленные лиды пропадут.",
    save: "Сохранить",
    lastChecked: (d) => `Проверено: ${d}`,
    lastError: "Последняя ошибка",
    pending: (n) => `Ожидают лидов: ${n}`,
    dead: (n) => `Не доставлено лидов: ${n}`,
    accountFilter: "Лиды каких Instagram-аккаунтов",
    accountFilterHelp: "Если ничего не выбрано — все аккаунты. Для агентств: аккаунт клиента A → CRM клиента A.",
    memberReadOnly: "Интеграции может менять только owner или admin.",
    botNotConfigured: "Telegram-бот платформы не настроен (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME).",
    brokenBanner: (n) => `Подключение ${n} потеряно, подключите заново. Лиды продолжают приходить в Telegram, а в CRM уйдут автоматически после восстановления.`,
    steps: "Шаги",
    tokenExpires: (d) => `Токен действует до: ${d}`,
    disable: "Выключить",
    enable: "Включить",
    errors: {
      invalid_token: "Токен недействителен или не хватает прав.",
      invalid_webhook: "Вебхук недействителен или не хватает прав.",
      invalid_webhook_url: "Неверный адрес вебхука. Вид: https://portal.bitrix24.ru/rest/1/код/",
      invalid_credentials: "Новые данные недействительны.",
      connection_failed: "Не удалось подключиться к сервису.",
      bot_not_configured: "Telegram-бот не настроен.",
      not_active: "Интеграция не активна — сначала проверьте подключение.",
      generic: "Произошла ошибка.",
    },
    telegram: {
      name: "Telegram",
      desc: "Новые лиды приходят сообщением в группу или личный чат с кнопкой «Связались».",
      privateBtn: "Подключить личный чат",
      groupBtn: "Добавить в группу",
      chats: "Подключённые чаты",
      noChats: "Чаты пока не подключены.",
      codeHelp: "Ссылка действует 15 минут и срабатывает один раз.",
      steps: [
        "Нажмите «Подключить личный чат» или «Добавить в группу».",
        "Откроется Telegram — нажмите START у бота (в группе подтвердите добавление бота).",
        "Бот напишет «Подключено». Можно подключить несколько чатов.",
        "Проверьте кнопкой «Отправить тестовый лид».",
      ],
    },
    amocrm: {
      name: "amoCRM",
      desc: "Для каждой заявки создаются новый контакт (имя + телефон) и новая сделка; данные клиента и запись диалога добавляются примечанием.",
      subdomain: "Поддомен",
      zone: "Доменная зона",
      token: "Долгосрочный токен",
      tokenExpiresAt: "Срок действия токена",
      tokenExpiresHelp: "Предупредим за 14 и за 3 дня до окончания.",
      pipeline: "Воронка",
      stage: "Этап",
      responsible: "Ответственный",
      noneOption: "— не выбрано —",
      campaignTag: "Добавлять название кампании тегом",
      nameTemplate: "Шаблон названия лида",
      nameTemplateHelp: "{name}, {product_interest}, {username}",
      igField: "Поле Instagram username (контакт)",
      loadOptions: "Загрузить воронки и сотрудников",
      steps: [
        "amoCRM → Настройки → Интеграции → «Создать интеграцию» → частная (внутренняя) интеграция.",
        "На вкладке «Ключи и доступы» создайте «Долгосрочный токен» (доступ к CRM, контактам, сделкам) и запишите срок.",
        "Введите поддомен (promtchi.amocrm.ru → promtchi) и вставьте токен.",
        "Нажмите «Подключить», затем выберите воронку и ответственного и проверьте «Тестовым лидом».",
      ],
    },
    bitrix: {
      name: "Bitrix24",
      desc: "Создаётся лид, запись диалога — комментарий в ленте. Если есть открытый лид, новый не создаётся.",
      webhookUrl: "Адрес входящего вебхука",
      webhookHelp: "https://portal.bitrix24.ru/rest/1/код/",
      responsible: "Ответственный",
      source: "Источник",
      loadOptions: "Загрузить сотрудников и источники",
      steps: [
        "Bitrix24 → Ресурсы разработчика → Другое → Входящий вебхук.",
        "Права: crm и user. Скопируйте адрес вебхука.",
        "Вставьте адрес сюда и нажмите «Подключить».",
        "Выберите ответственного и источник, проверьте «Тестовым лидом».",
      ],
    },
  },
  dashboard: {
    leadsPeriod: "Лиды",
    conversion: "Конверсия в номер",
    conversionHelp: "Доля оставивших номер среди общавшихся с ассистентом",
    undelivered: "Недоставленные лиды",
    undeliveredHelp: "Не дошли до Telegram/CRM",
    last30: "Последние 30 дней",
  },
  inbox: {
    badgeAssistant: "Ассистент",
    badgeOperator: "Оператор",
    badgeLead: "Лид получен",
    pause: "Остановить бота",
    resume: "Включить бота",
    leadPanel: "Данные лида",
    name: "Имя",
    phone: "Телефон",
    interest: "Интерес",
    campaign: "Кампания",
    crm: "CRM",
    operatorUntil: (d) => `Бот молчит до ${d}`,
    pausedNote: "Бот остановлен вручную",
  },
  diagnostics: {
    deliveryErrors: "Ошибки доставки лидов",
    deliveryErrorsEmpty: "Недоставленных лидов нет.",
    integrationHealth: "Состояние интеграций",
    integrationHealthEmpty: "Интеграции не подключены.",
    llmHealth: "AI / резервный режим",
    templateMode: (u) => `Режим шаблонов до ${u}`,
    llmOk: "AI-провайдер работает",
    llmNotConfigured: "AI-провайдер не настроен — ассистент работает только по шаблонам",
    llmErrors: (n) => `Ошибки AI (7 дней): ${n}`,
    blockedReplies: (n) => `Заблокированные ответы (7 дней): ${n}`,
    aiUsage: (u, l) => `AI-диалоги: ${u} / ${l}`,
    cost: (c) => `Расход (30 дней): $${c}`,
  },
};

export const assistantEn: AssistantDictionary = {
  nav: { assistant: "Assistant", leads: "Leads", integrations: "Integrations" },
  tokenBanner: {
    title: "Instagram connection lost",
    body: (u) => `Meta rejected the token for ${u} — campaigns and the assistant are not working. Reconnect the account.`,
    cta: "Reconnect",
  },
  tokenStatus: { active: "Connected", broken: "Disconnected", brokenHelp: "Meta rejected the token. Reconnect the account." },
  campaignToggle: "Hand people who reply over to the assistant",
  campaignToggleHelp:
    "When someone replies to this campaign's DM, the lead assistant continues the chat: asks for name and phone and sends the lead to Telegram/CRM. The assistant must be enabled and approved on the Assistant page.",
  usage: {
    aiConversations: "AI conversations (this month)",
    aiConversationsHelp: "When the limit is used up the assistant switches to fixed templates; number collection never stops.",
  },
  common: {
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    cancel: "Cancel",
    delete: "Delete",
    add: "Add",
    remove: "Remove",
    copy: "Copy",
    copied: "Copied",
    loading: "Loading…",
    loadError: "Failed to load",
    all: "All",
    optional: "optional",
    close: "Close",
    refresh: "Refresh",
    readOnly: "Read only: changing this needs an owner or admin.",
    confirm: "Confirm",
  },
  assistant: {
    title: "Lead assistant",
    subtitle: "In Instagram DMs it learns what the customer needs, takes name and phone, sends the lead to Telegram/CRM and hands the chat to an operator.",
    statusOn: "Assistant is on",
    statusOff: "Assistant is off",
    statusDraft: "Profile not approved",
    statusDraftHelp: "The assistant will not go live with an unapproved profile. Fill it in, try it in the test chat and approve.",
    enable: "Turn on",
    disable: "Turn off",
    approve: "Approve and turn on",
    approving: "Approving…",
    approvedOn: (d) => `Approved: ${d}`,
    fromTelegram: (d) => `Filled in via Telegram, ${d}`,
    accountScope: "For account",
    allAccounts: "All accounts",
    steps: { autofill: "1. Auto-fill", edit: "2. Edit", test: "3. Test chat" },
    autofill: {
      title: "Create a draft",
      help: "A draft profile is built from your Instagram bio, recent posts and (optionally) your website. You review, edit and approve it.",
      websiteLabel: "Website (optional)",
      websitePlaceholder: "https://company.com",
      run: "Create draft",
      running: "Working…",
      done: "Draft ready — check it in step 2.",
      errors: {
        bad_url: "The website address is not valid.",
        private_address: "That address cannot be fetched.",
        fetch_failed: "Could not read the website.",
        no_llm: "No AI provider configured (LLM_PROVIDER, LLM_API_KEY).",
        token_expired: "Instagram connection lost. Reconnect the account.",
        autofill_failed: "Could not create a draft. Try again later.",
      },
      telegramTitle: "Fill in via Telegram",
      telegramHelp: "Send voice notes, a photo of your price list or an Excel file — the bot asks the questions. 10 minutes is enough.",
      telegramBtn: "Fill in via Telegram",
      telegramError: "Telegram bot is not configured.",
      skipToEdit: "I'll fill it in manually",
    },
    profile: {
      company: "Company name",
      description: "Short description",
      descriptionHelp: "What do you do? 1–3 sentences.",
      categories: "Product / service categories",
      categoriesHelp: "E.g. “Sofas — corner, straight, sofa-beds”.",
      categoryName: "Category",
      categoryNote: "Note (one line)",
      products: "Products and prices",
      productsHelp: "Prices are only used when the price policy allows quoting them. For a product without a price the assistant says “the manager will tell you”.",
      productName: "Name",
      productPrice: "Price (UZS)",
      productFrom: "from",
      noPrice: "no price",
      bulkTitle: "Paste a list",
      bulkPlaceholder: "Corner sofa Milan — 4 500 000\nArmchair — 1.2 mln\nTable — 300k",
      bulkApply: "Add list",
      pricePolicy: "Price policy",
      policyNever: "Never quote prices (manager does)",
      policyFrom: "Quote “from ...”",
      policyExact: "Quote the exact listed price",
      policyHelp: "The assistant only quotes a listed price — it never calculates or gives discounts.",
      tone: "Tone",
      toneFriendly: "Friendly",
      toneFormal: "Formal",
      persona: "Assistant name",
      personaHelp: "Empty = “company assistant”. If asked, it says it is an assistant.",
      extraField: "Extra field besides the phone",
      extraFieldHelp: "At most one (e.g. “City”). The goal is the phone number.",
      finalMessage: "Final message template",
      finalMessageHelp: "{name} and {phone} are replaced with the customer's details.",
      address: "Address / branches",
      delivery: "Delivery",
      workingHours: "Working hours",
      payments: "Payment methods",
      faqs: "Frequently asked questions",
      faqsHelp: "Up to 5 questions with short answers.",
      faqQuestion: "Question",
      faqAnswer: "Answer",
      counter: (u, m) => `${u} / ${m} chars`,
      tooLong: "The profile text must not exceed 6,000 characters.",
      instructionWarning: "Some text looks like an instruction to the bot. The assistant still follows its own fixed rules.",
      requiredMissing: "A name, a description and at least one product or category are required.",
      productLimit: "At most 200 products.",
    },
    rules: {
      title: "Rules",
      campaignReplies: "Answer people who reply to a campaign DM",
      inboundDm: "Answer inbound DMs",
      operatorPause: "Bot stays silent after an operator replies (hours)",
      operatorPauseHelp: "When an operator writes from the Instagram app or the Messages page.",
      maxMessages: "Bot message limit per conversation",
      fallbackLead: "Also send customers without a phone as a “no phone” lead",
      postHandoff: "If the customer writes after the hand-off, briefly answer their question and say the manager will give the details (up to 3 times)",
      hoursFilter: "Only answer during working hours",
      hoursFilterHelp: "Outside working hours it still asks for the phone, with a dedicated text.",
      from: "From",
      to: "To",
      days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      offHoursMessage: "Out-of-hours text",
      priceReminder: "Remind me in Telegram when prices are 30 days old",
    },
    sandbox: {
      title: "Test chat",
      help: "You are the customer. The assistant answers with exactly the same logic as on Instagram; nothing is sent to Instagram.",
      placeholder: "Customer message…",
      send: "Send",
      reset: "Start over",
      thinking: "Typing…",
      leadCreated: (s) => `📥 A lead would be created. ${s}`,
      blocked: "The filter blocked this reply and sent a template.",
      saveFirst: "Save the profile first.",
      noLlm: "No AI provider configured, the test chat is unavailable.",
      empty: "Write the first message, e.g. “Hi, do you have sofas?”",
    },
    gaps: {
      title: "Unanswered questions",
      help: "Questions the assistant answered with “the manager will tell you”. Your answer is added to the FAQ.",
      empty: "No unanswered questions yet.",
      hits: (n) => `${n}×`,
      answerPlaceholder: "Your answer…",
      answer: "Answer",
      ignore: "Ignore",
    },
    changes: { title: "Change history", empty: "No changes.", panel: "panel", telegram: "Telegram" },
    errors: {
      save: "Could not save.",
      approve: "Could not approve.",
      incomplete: "The profile is incomplete: a name, a description and at least one product or category are required.",
      notApproved: "Approve the profile first.",
    },
  },
  leads: {
    title: "Leads",
    subtitle: "Leads collected by the assistant or from phone numbers customers wrote themselves, and their delivery to Telegram/CRM.",
    export: "Download CSV",
    searchPlaceholder: "Name, phone, @username, interest",
    allStatuses: "All statuses",
    allSources: "All sources",
    from: "From",
    to: "To",
    status: { NEW: "New", SENT: "Sent", PARTIAL: "Partial", FAILED: "Failed" },
    source: { CAMPAIGN: "Campaign", INBOUND_DM: "Inbound DM" },
    columns: { date: "Date", name: "Name", phone: "Phone", username: "Instagram", interest: "Interest", source: "Source", delivery: "Delivery", actions: "Actions" },
    copyPhone: "Copy number",
    openChat: "Chat",
    details: "Details",
    redeliver: "Resend",
    redelivering: "Sending…",
    redeliverQueued: (n) => `${n} deliveries queued`,
    empty: "No leads yet",
    emptyHelp: "Turn on the assistant or wait for campaign customers to write a number — leads will show up here.",
    repeat: "Repeat",
    test: "TEST",
    noPhone: "no phone",
    complaint: "complaint",
    contacted: "Contacted",
    page: (p, n) => `${p} / ${n}`,
    prev: "Previous",
    next: "Next",
    detail: {
      summary: "Summary",
      transcript: "Conversation transcript",
      deliveries: "Delivery history",
      attempts: (n) => `${n} attempts`,
      openInCrm: "Open in CRM",
      campaign: "Campaign",
      keyword: "Keyword",
      tracked: "Link",
      trackedYes: "clicked",
      noDeliveries: "There were no active integrations.",
      repeatNote: (n) => `This customer contacted you ${n} times within 30 days.`,
      nextAttempt: (d) => `next attempt: ${d}`,
    },
    delivery: { PENDING: "Pending", SENT: "Sent", FAILED: "Will retry", DEAD: "Not delivered", TELEGRAM: "Telegram", AMOCRM: "amoCRM", BITRIX24: "Bitrix24" },
  },
  integrations: {
    title: "Integrations",
    subtitle: "Choose where leads go. Each integration works independently: one failing never affects the others.",
    status: { ACTIVE: "Active", BROKEN: "Disconnected", DISABLED: "Disabled" },
    notConnected: "Not connected",
    connect: "Connect",
    reconnect: "Reconnect",
    check: "Check connection",
    checking: "Checking…",
    checkOk: "Connection works",
    checkFailed: "Connection failed",
    testLead: "Send test lead",
    testSent: "Test lead sent — see the result on the Leads page.",
    disconnect: "Disconnect",
    confirmDelete: "Delete this integration? Undelivered leads will be lost.",
    save: "Save",
    lastChecked: (d) => `Checked: ${d}`,
    lastError: "Last error",
    pending: (n) => `${n} leads waiting`,
    dead: (n) => `${n} leads not delivered`,
    accountFilter: "Leads from which Instagram accounts",
    accountFilterHelp: "Nothing selected = all accounts. For agencies: client A's account → client A's CRM.",
    memberReadOnly: "Only an owner or admin can change integrations.",
    botNotConfigured: "The platform Telegram bot is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME).",
    brokenBanner: (n) => `${n} connection lost, reconnect it. Leads keep reaching Telegram and will be sent to the CRM automatically once it is repaired.`,
    steps: "Steps",
    tokenExpires: (d) => `Token valid until: ${d}`,
    disable: "Disable",
    enable: "Enable",
    errors: {
      invalid_token: "The token is invalid or lacks permissions.",
      invalid_webhook: "The webhook is invalid or lacks permissions.",
      invalid_webhook_url: "The webhook address is not valid. Format: https://portal.bitrix24.com/rest/1/code/",
      invalid_credentials: "The new credentials are invalid.",
      connection_failed: "Could not reach the service.",
      bot_not_configured: "The Telegram bot is not configured.",
      not_active: "The integration is not active — check the connection first.",
      generic: "Something went wrong.",
    },
    telegram: {
      name: "Telegram",
      desc: "New leads arrive as a message in a group or private chat, with a “Contacted” button.",
      privateBtn: "Connect private chat",
      groupBtn: "Add to a group",
      chats: "Connected chats",
      noChats: "No chats connected yet.",
      codeHelp: "The link is valid for 15 minutes and works once.",
      steps: [
        "Press “Connect private chat” or “Add to a group”.",
        "Telegram opens — press START on the bot (in a group, confirm adding the bot).",
        "The bot replies “Connected”. You can connect several chats.",
        "Verify with “Send test lead”.",
      ],
    },
    amocrm: {
      name: "amoCRM",
      desc: "Every lead creates a new contact (name + phone) and a new lead; the customer's details and the conversation transcript are added as a note.",
      subdomain: "Subdomain",
      zone: "Domain zone",
      token: "Long-lived token",
      tokenExpiresAt: "Token expiry date",
      tokenExpiresHelp: "We warn you 14 and 3 days before it expires.",
      pipeline: "Pipeline",
      stage: "Stage",
      responsible: "Responsible user",
      noneOption: "— none —",
      campaignTag: "Add the campaign name as a tag",
      nameTemplate: "Lead name template",
      nameTemplateHelp: "{name}, {product_interest}, {username}",
      igField: "Instagram username field (contact)",
      loadOptions: "Load pipelines and users",
      steps: [
        "amoCRM → Settings → Integrations → “Create integration” → private (internal) integration.",
        "On the “Keys and access” tab create a “Long-lived token” (CRM, contacts, leads access) and note its expiry.",
        "Enter the subdomain (promtchi.amocrm.ru → promtchi) and paste the token.",
        "Press “Connect”, then choose the pipeline and responsible user and verify with “Send test lead”.",
      ],
    },
    bitrix: {
      name: "Bitrix24",
      desc: "A lead is created; the transcript becomes a timeline comment. An open lead is reused instead of creating a new one.",
      webhookUrl: "Inbound webhook URL",
      webhookHelp: "https://portal.bitrix24.com/rest/1/code/",
      responsible: "Responsible user",
      source: "Source",
      loadOptions: "Load users and sources",
      steps: [
        "Bitrix24 → Developer resources → Other → Inbound webhook.",
        "Permissions: crm and user. Copy the webhook URL.",
        "Paste it here and press “Connect”.",
        "Choose the responsible user and source, then verify with “Send test lead”.",
      ],
    },
  },
  dashboard: {
    leadsPeriod: "Leads",
    conversion: "Phone capture rate",
    conversionHelp: "Share of assistant chats that ended with a phone number",
    undelivered: "Undelivered leads",
    undeliveredHelp: "Did not reach Telegram/CRM",
    last30: "Last 30 days",
  },
  inbox: {
    badgeAssistant: "Assistant",
    badgeOperator: "Operator",
    badgeLead: "Lead captured",
    pause: "Stop the bot",
    resume: "Resume the bot",
    leadPanel: "Lead details",
    name: "Name",
    phone: "Phone",
    interest: "Interest",
    campaign: "Campaign",
    crm: "CRM",
    operatorUntil: (d) => `Bot is silent until ${d}`,
    pausedNote: "Bot was stopped manually",
  },
  diagnostics: {
    deliveryErrors: "Lead delivery errors",
    deliveryErrorsEmpty: "No undelivered leads.",
    integrationHealth: "Integration health",
    integrationHealthEmpty: "No integrations connected.",
    llmHealth: "AI / fallback mode",
    templateMode: (u) => `Template-only mode until ${u}`,
    llmOk: "AI provider is working",
    llmNotConfigured: "No AI provider configured — the assistant uses fixed templates only",
    llmErrors: (n) => `AI errors (7 days): ${n}`,
    blockedReplies: (n) => `Blocked replies (7 days): ${n}`,
    aiUsage: (u, l) => `AI conversations: ${u} / ${l}`,
    cost: (c) => `Cost (30 days): $${c}`,
  },
};
