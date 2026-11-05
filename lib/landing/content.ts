/**
 * Copy for the landing sections that the shared dictionary does not hold:
 * networks, modules, use cases, the comparison and the extra trust points
 * and questions. Keyed by content locale like lib/seo-pages (uz-Cyrl is
 * transliterated from uz on the client).
 *
 * Every claim here is a mechanism that exists in the product today (see the
 * module pages under app/(dashboard) and lib/channels/capabilities.json). No
 * customer counts, ratings, testimonials or competitor prices.
 */

import type { Locale } from "@/lib/i18n/config";
import type { BrandKey } from "@/components/brand-icons";
import type { IconName } from "@/components/icons";

export interface LandingStat {
  value: number;
  suffix?: string;
  label: string;
}

export interface LandingModule {
  icon: IconName;
  title: string;
  body: string;
}

export interface LandingUseCase {
  title: string;
  who: string;
  body: string;
  /** Comment, reply, result: three short steps. */
  flow: [string, string, string];
  cta: string;
  href: string;
}

export interface LandingPoint {
  title: string;
  body: string;
}

export interface LandingCompareRow {
  label: string;
  ours: string;
  other: string;
}

export interface LandingFaq {
  question: string;
  answer: string;
}

export interface LandingCopy {
  nav: { networks: string; modules: string; useCases: string; pricing: string; faq: string };
  /** Under the hero actions, next to the five network logos. */
  networksLine: string;
  proof: LandingStat[];
  networksTitle: string;
  networksBody: string;
  networks: Record<BrandKey, string>;
  modulesTitle: string;
  modulesBody: string;
  modules: LandingModule[];
  /** Caption under the dashboard picture: the numbers in it are an example. */
  sampleData: string;
  useCasesTitle: string;
  useCasesBody: string;
  useCases: LandingUseCase[];
  /** Shown after the dictionary's four trust points. */
  trustExtra: LandingPoint[];
  compareTitle: string;
  compareBody: string;
  compareHead: { need: string; ours: string; other: string };
  compareRows: LandingCompareRow[];
  compareLink: string;
  /** Asked after the dictionary's five questions. */
  faqs: LandingFaq[];
}

const uz: LandingCopy = {
  nav: { networks: "Tarmoqlar", modules: "Imkoniyatlar", useCases: "Kim uchun", pricing: "Narxlar", faq: "Savollar" },
  networksLine: "Instagram, Facebook, Threads, YouTube va Telegram — bitta panelda.",
  proof: [
    { value: 5, label: "tarmoq bitta panelda" },
    { value: 24, suffix: "/7", label: "izohlar kuzatiladi" },
    { value: 1, label: "soniyada izohdan DM gacha" },
    { value: 0, label: "skraping va parol ulashish" },
  ],
  networksTitle: "Beshta tarmoq, bitta boshqaruv",
  networksBody:
    "Har bir tarmoq o'zining rasmiy kirish oynasi orqali ulanadi. Izohlar, xabarlar, postlar va statistika bitta panelga yig'iladi, har bir tarmoqning o'z qoidalari esa avtomatik hisobga olinadi.",
  networks: {
    instagram: "Izoh → DM kampaniyalar, Direct va story triggerlar, post, reel va story chiqarish, statistika.",
    facebook: "Sahifa izohlari va Messenger bitta joyda, izohga shaxsiy javob, post va reel chiqarish.",
    threads: "Post va karusel chiqarish, javoblarni boshqarish, statistika.",
    youtube: "Video va Shorts chiqarish, izohlarni boshqarish, statistika.",
    telegram: "Kanalga post, muhokama izohlari, kanal xabarlari va Business chatlar.",
  },
  modulesTitle: "Izohdan sotuvgacha — bitta platformada",
  modulesBody:
    "Kampaniyalar, AI javoblar, kontent reja, CRM va reklama bir-biriga ulangan: izoh yozgan odam kontaktga aylanadi, uning javobi va bosishi hisobotda ko'rinadi.",
  modules: [
    {
      icon: "megaphone",
      title: "Izoh → DM kampaniyalar",
      body: "Post yoki reel uchun kalit so'z, ochiq javob va DM. DM havola yoki fayl olib boradi, bosishlar hisoblanadi.",
    },
    {
      icon: "sparkles",
      title: "JavobAI",
      body: "Izoh va xabarlarga bilimlar bazangizdan javob beradi. Avval kuzatadi, keyin qoralama taklif qiladi, aniqligi isbotlangach o'zi javob beradi.",
    },
    {
      icon: "activity",
      title: "Instagram triggerlar",
      body: "Direct xabar, reklamadan kelgan xabar, ig.me havola, story mention, story reply va jonli efir izohlari.",
    },
    {
      icon: "share",
      title: "Flow Builder",
      body: "Ko'p bosqichli DM oqimlari: shablondan yoki AI qoralamasidan boshlang, sinab ko'ring, versiyalarini saqlang.",
    },
    {
      icon: "calendar",
      title: "Kontent reja",
      body: "Post, reel, video va karuselni beshta tarmoqqa bitta kalendardan rejalashtiring va chiqaring.",
    },
    {
      icon: "trending",
      title: "Kontent intellekti",
      body: "Har bir post akkauntning 30 kunlik medianasiga solishtiriladi. Haftalik hisobot va Reel ssenariylari bilan ikki haftalik reja.",
    },
    {
      icon: "users",
      title: "CRM",
      body: "Izoh yozgan yoki xabar yuborgan har bir kishi kontaktga aylanadi: bosqich, teg, segment va xabar tarqatish.",
    },
    {
      icon: "inbox",
      title: "AI yordamchi va lidlar",
      body: "Yordamchi suhbatda lid yig'adi va uni Telegram, amoCRM yoki Bitrix24 ga yuboradi. CSV eksport ham bor.",
    },
    {
      icon: "chart",
      title: "Reklama",
      body: "AI medianadan ikki baravar yaxshi ishlagan postni reklamaga taklif qiladi. Har bir sarf faqat sizning roziligingiz bilan.",
    },
    {
      icon: "home",
      title: "Konkurs va ballar",
      body: "Izohlar orqali konkurs o'tkazing, ishtirok shartlarini tekshiring va faol obunachilarga ball bering.",
    },
    {
      icon: "list",
      title: "Analitika va hisobotlar",
      body: "Kampaniya, AI, sotuv va voronka ko'rsatkichlari. Mijozga login'siz ochiladigan hisobot havolasi.",
    },
    {
      icon: "plug",
      title: "Webhook va ManyChat'dan ko'chish",
      body: "Hodisalarni o'z tizimingizga webhook bilan yuboring. ManyChat'dagi ishlarni yo'riqnoma bilan ko'chirib o'ting.",
    },
  ],
  sampleData: "Rasmda namunaviy ma'lumotlar.",
  useCasesTitle: "Har bir biznes — o'z kalit so'zi bilan",
  useCasesBody:
    "Tayyor shablondan boshlang: kalit so'z, javob matni va kuzatiluvchi havola allaqachon yozilgan, faqat o'zingizga moslaysiz.",
  useCases: [
    {
      title: "Onlayn do'kon",
      who: "Instagram va Telegram orqali sotadiganlar",
      body: "Reel ostida narx so'rashadi — har biriga narx va mahsulot havolasi DM'da boradi, bosishlar hisoblanadi, xaridor CRM'ga tushadi.",
      flow: ['Izoh: "narx"', "DM: narx va havola", "Natija: bosish va lid"],
      cta: "Shablonni ko'rish",
      href: "/templates/dtc-product-link",
    },
    {
      title: "Kurs va ekspertlar",
      who: "Vebinar, marafon va konsultatsiya o'tkazadiganlar",
      body: "Postga \"dars\" deb yozganlar ro'yxatdan o'tish havolasini oladi. Keyingi savollarga JavobAI bilimlar bazasidan javob beradi.",
      flow: ['Izoh: "dars"', "DM: ro'yxat havolasi", "Natija: vebinar ishtirokchisi"],
      cta: "Shablonni ko'rish",
      href: "/templates/course-webinar",
    },
    {
      title: "Xizmat ko'rsatish",
      who: "Go'zallik salonlari, restoranlar va mahalliy xizmatlar",
      body: "Narxlar ro'yxati, menyu va bron havolasi bir zumda boradi. Kontent reja postlarni oldindan chiqaradi, takroriy savollarga AI javob beradi.",
      flow: ['Izoh: "bron"', "DM: narxlar va bron", "Natija: band qilingan vaqt"],
      cta: "Shablonni ko'rish",
      href: "/templates/beauty-price-list",
    },
    {
      title: "Agentliklar",
      who: "Bir nechta mijoz akkauntini yuritadiganlar",
      body: "Har bir mijoz o'z akkaunti va jamoa rollari bilan. Mijozga login'siz ochiladigan hisobot boradi: yuborishlar, bosishlar va CTR.",
      flow: ["Mijoz akkaunti", "Kampaniya va kontent", "Ulashiladigan hisobot"],
      cta: "Agentliklar uchun",
      href: "/instagram-dm-automation-agencies",
    },
  ],
  trustExtra: [
    {
      title: "AI ruxsat bilan ishlaydi",
      body: "JavobAI avval faqat kuzatadi, keyin siz tasdiqlaydigan qoralama yozadi. O'zi javob berishga aniqligi isbotlangandan keyingina o'tadi va bitta tugma bilan to'xtatiladi.",
    },
    {
      title: "Reklama byudjeti nazoratda",
      body: "AI faqat taklif qiladi: har bir ishga tushirish sizning tugmangiz bilan, kunlik va oylik limit ichida. Lid narxi oshib ketsa, reklama o'zi pauzaga tushadi.",
    },
  ],
  compareTitle: "Chatbot konstruktoridan farqi",
  compareBody:
    "Keng chatbot platformalari ko'p narsaga yaraydi, lekin sozlash uzoq davom etadi. SocialAuto yo'lni qisqa qiladi: kalit so'z, post, javob, havola, natija.",
  compareHead: { need: "Ehtiyoj", ours: "SocialAuto", other: "Odatdagi chatbot konstruktori" },
  compareRows: [
    {
      label: "Ishga tushirish",
      ours: "Shablondan bir necha daqiqada: kalit so'z, javob va havola tayyor.",
      other: "Oqimni noldan chizish va sinash.",
    },
    {
      label: "Til",
      ours: "Interfeys o'zbek (lotin va kirill), rus va ingliz tillarida.",
      other: "O'zbek tili ko'pincha yo'q.",
    },
    {
      label: "Kontent",
      ours: "Kontent reja va post tahlili shu panelda.",
      other: "Faqat xabarlar, postlar uchun alohida servis kerak.",
    },
    {
      label: "Hisobot",
      ours: "Bosishlar, CTR va mijozga ulashiladigan hisobot havolasi.",
      other: "Suhbat statistikasi, mijozga tozalab berish kerak.",
    },
    {
      label: "Ko'chib o'tish",
      ours: "ManyChat'dan ko'chirish ustasi bosqichma-bosqich olib o'tadi.",
      other: "Hammasini qo'lda qayta qurish.",
    },
  ],
  compareLink: "ManyChat alternativasi haqida batafsil",
  faqs: [
    {
      question: "Qaysi tarmoqlar qo'llab-quvvatlanadi?",
      answer:
        "Instagram (izoh → DM, Direct, story triggerlar, post), Facebook sahifa (izohlar, Messenger, post), Threads va YouTube (post, izohlarni boshqarish, statistika) hamda Telegram kanal (post, muhokama izohlari, kanal xabarlari).",
    },
    {
      question: "AI noto'g'ri javob yozib yubormaydimi?",
      answer:
        "JavobAI har bir akkauntda avval kuzatish rejimida ishlaydi, keyin siz tasdiqlaydigan qoralamalar yozadi. Javobda bilimlar bazasida yo'q narx yoki raqam bo'lsa, u yuborilmaydi va sizga qoralama bo'lib keladi. Mustaqil rejim aniqlik isbotlangandan keyingina yoqiladi.",
    },
    {
      question: "Reklamaga pul o'zi sarflanib ketmaydimi?",
      answer:
        "Yo'q. AI faqat taklif qiladi, ishga tushirishni siz bosasiz. Kunlik va oylik limit qo'yiladi, lid narxi belgilangandan oshsa reklama pauzaga tushadi, Meta'da esa hammasi to'xtatilgan holda yaratiladi.",
    },
    {
      question: "ManyChat'dan ko'chib o'tsam bo'ladimi?",
      answer:
        "Ha. Ko'chirish ustasi ishingizni bosqichma-bosqich olib o'tadi: har bir qadamni ko'rib chiqasiz va tayyor bo'lgach o'zingiz ishga tushirasiz.",
    },
    {
      question: "Interfeys o'zbek tilidami?",
      answer:
        "Ha. Sayt va panel o'zbek (lotin va kirill), rus va ingliz tillarida ishlaydi, til har bir sahifada almashtiriladi.",
    },
  ],
};

const ru: LandingCopy = {
  nav: { networks: "Сети", modules: "Возможности", useCases: "Для кого", pricing: "Цены", faq: "Вопросы" },
  networksLine: "Instagram, Facebook, Threads, YouTube и Telegram — в одной панели.",
  proof: [
    { value: 5, label: "сетей в одной панели" },
    { value: 24, suffix: "/7", label: "мониторинг комментариев" },
    { value: 1, label: "секунда от комментария до DM" },
    { value: 0, label: "скрапинга и передачи паролей" },
  ],
  networksTitle: "Пять сетей, одно управление",
  networksBody:
    "Каждая сеть подключается через её официальное окно входа. Комментарии, сообщения, публикации и статистика собираются в одной панели, а правила каждой платформы соблюдаются автоматически.",
  networks: {
    instagram: "Кампании комментарий → DM, триггеры Direct и сторис, публикация постов, Reels и сторис, статистика.",
    facebook: "Комментарии страницы и Messenger в одном месте, личный ответ на комментарий, публикация постов и Reels.",
    threads: "Публикация постов и каруселей, управление ответами, статистика.",
    youtube: "Публикация видео и Shorts, управление комментариями, статистика.",
    telegram: "Посты в канал, комментарии обсуждения, сообщения канала и Business-чаты.",
  },
  modulesTitle: "От комментария до продажи — на одной платформе",
  modulesBody:
    "Кампании, AI-ответы, контент-план, CRM и реклама связаны между собой: тот, кто оставил комментарий, становится контактом, а его ответ и клик видны в отчёте.",
  modules: [
    {
      icon: "megaphone",
      title: "Кампании комментарий → DM",
      body: "Ключевое слово, публичный ответ и DM для поста или Reels. DM несёт ссылку или файл, клики считаются.",
    },
    {
      icon: "sparkles",
      title: "JavobAI",
      body: "Отвечает на комментарии и сообщения по вашей базе знаний. Сначала наблюдает, потом предлагает черновики, а сам отвечает, когда доказал точность.",
    },
    {
      icon: "activity",
      title: "Триггеры Instagram",
      body: "Сообщение в Direct, сообщение из рекламы, ссылка ig.me, упоминание и ответ на сторис, комментарии в прямом эфире.",
    },
    {
      icon: "share",
      title: "Flow Builder",
      body: "Многошаговые DM-сценарии: начните с шаблона или AI-черновика, протестируйте и храните версии.",
    },
    {
      icon: "calendar",
      title: "Контент-план",
      body: "Планируйте и публикуйте посты, Reels, видео и карусели в пять сетей из одного календаря.",
    },
    {
      icon: "trending",
      title: "Контент-аналитика",
      body: "Каждый пост сравнивается с 30-дневной медианой аккаунта. Еженедельный отчёт и план на две недели со сценариями Reels.",
    },
    {
      icon: "users",
      title: "CRM",
      body: "Каждый, кто прокомментировал или написал, становится контактом: этап, теги, сегменты и рассылки.",
    },
    {
      icon: "inbox",
      title: "AI-ассистент и лиды",
      body: "Ассистент собирает лиды в переписке и отправляет их в Telegram, amoCRM или Bitrix24. Есть экспорт в CSV.",
    },
    {
      icon: "chart",
      title: "Реклама",
      body: "AI предлагает продвигать пост, который сработал вдвое лучше медианы. Любой расход — только с вашего согласия.",
    },
    {
      icon: "home",
      title: "Конкурсы и баллы",
      body: "Проводите конкурсы через комментарии, проверяйте условия участия и начисляйте баллы активным подписчикам.",
    },
    {
      icon: "list",
      title: "Аналитика и отчёты",
      body: "Показатели кампаний, AI, продаж и воронки. Ссылка на отчёт открывается клиенту без входа.",
    },
    {
      icon: "plug",
      title: "Вебхуки и переезд с ManyChat",
      body: "Отправляйте события в свою систему через вебхуки. Переносите работу из ManyChat по пошаговой инструкции.",
    },
  ],
  sampleData: "На изображении — примерные данные.",
  useCasesTitle: "У каждого бизнеса — своё ключевое слово",
  useCasesBody:
    "Начните с готового шаблона: ключевое слово, текст ответа и отслеживаемая ссылка уже написаны, остаётся подстроить под себя.",
  useCases: [
    {
      title: "Интернет-магазин",
      who: "Продают через Instagram и Telegram",
      body: "Под Reels спрашивают цену — каждому в DM уходит цена и ссылка на товар, клики считаются, покупатель попадает в CRM.",
      flow: ['Комментарий: "цена"', "DM: цена и ссылка", "Итог: клик и лид"],
      cta: "Смотреть шаблон",
      href: "/templates/dtc-product-link",
    },
    {
      title: "Курсы и эксперты",
      who: "Проводят вебинары, марафоны и консультации",
      body: "Написавшие \"урок\" под постом получают ссылку на регистрацию. На следующие вопросы JavobAI отвечает по базе знаний.",
      flow: ['Комментарий: "урок"', "DM: ссылка на регистрацию", "Итог: участник вебинара"],
      cta: "Смотреть шаблон",
      href: "/templates/course-webinar",
    },
    {
      title: "Сфера услуг",
      who: "Салоны красоты, рестораны и локальные сервисы",
      body: "Прайс, меню и ссылка на бронь уходят мгновенно. Контент-план публикует посты заранее, на типовые вопросы отвечает AI.",
      flow: ['Комментарий: "бронь"', "DM: прайс и бронь", "Итог: забронированное время"],
      cta: "Смотреть шаблон",
      href: "/templates/beauty-price-list",
    },
    {
      title: "Агентства",
      who: "Ведут несколько клиентских аккаунтов",
      body: "У каждого клиента свой аккаунт и роли команды. Клиент получает отчёт без входа: отправки, клики и CTR.",
      flow: ["Аккаунт клиента", "Кампании и контент", "Отчёт для клиента"],
      cta: "Для агентств",
      href: "/instagram-dm-automation-agencies",
    },
  ],
  trustExtra: [
    {
      title: "AI работает с разрешения",
      body: "JavobAI сначала только наблюдает, потом пишет черновики, которые вы утверждаете. Отвечать сам он начинает, лишь доказав точность, и выключается одной кнопкой.",
    },
    {
      title: "Рекламный бюджет под контролем",
      body: "AI только предлагает: каждый запуск — ваша кнопка, в пределах дневного и месячного лимита. Если цена лида растёт, реклама сама встаёт на паузу.",
    },
  ],
  compareTitle: "Чем отличается от конструктора чат-ботов",
  compareBody:
    "Большие чат-бот платформы умеют многое, но настройка занимает время. SocialAuto делает путь коротким: ключевое слово, пост, ответ, ссылка, результат.",
  compareHead: { need: "Задача", ours: "SocialAuto", other: "Обычный конструктор чат-ботов" },
  compareRows: [
    {
      label: "Запуск",
      ours: "Из шаблона за несколько минут: ключевое слово, ответ и ссылка готовы.",
      other: "Сценарий рисуется и тестируется с нуля.",
    },
    {
      label: "Язык",
      ours: "Интерфейс на узбекском (латиница и кириллица), русском и английском.",
      other: "Узбекского языка часто нет.",
    },
    {
      label: "Контент",
      ours: "Контент-план и разбор постов в той же панели.",
      other: "Только сообщения, для постов нужен отдельный сервис.",
    },
    {
      label: "Отчёты",
      ours: "Клики, CTR и ссылка на отчёт для клиента.",
      other: "Статистика диалогов, для клиента её нужно чистить.",
    },
    {
      label: "Переезд",
      ours: "Мастер переноса из ManyChat проводит по шагам.",
      other: "Всё пересобирать вручную.",
    },
  ],
  compareLink: "Подробнее об альтернативе ManyChat",
  faqs: [
    {
      question: "Какие сети поддерживаются?",
      answer:
        "Instagram (комментарий → DM, Direct, триггеры сторис, публикации), страница Facebook (комментарии, Messenger, публикации), Threads и YouTube (публикации, управление комментариями, статистика) и канал Telegram (посты, комментарии обсуждения, сообщения канала).",
    },
    {
      question: "AI не отправит неправильный ответ?",
      answer:
        "В каждом аккаунте JavobAI сначала работает в режиме наблюдения, затем пишет черновики, которые вы утверждаете. Если в ответе есть цена или число, которых нет в базе знаний, он не отправляется и приходит вам черновиком. Самостоятельный режим включается только после доказанной точности.",
    },
    {
      question: "Деньги на рекламу не потратятся сами?",
      answer:
        "Нет. AI только предлагает, запуск нажимаете вы. Ставятся дневной и месячный лимиты, при росте цены лида реклама встаёт на паузу, а в Meta всё создаётся в остановленном состоянии.",
    },
    {
      question: "Можно переехать с ManyChat?",
      answer:
        "Да. Мастер переноса проводит по шагам: вы проверяете каждый шаг и запускаете сами, когда всё готово.",
    },
    {
      question: "Интерфейс есть на узбекском?",
      answer:
        "Да. Сайт и панель работают на узбекском (латиница и кириллица), русском и английском, язык переключается на каждой странице.",
    },
  ],
};

const en: LandingCopy = {
  nav: { networks: "Networks", modules: "Features", useCases: "Use cases", pricing: "Pricing", faq: "FAQ" },
  networksLine: "Instagram, Facebook, Threads, YouTube and Telegram — in one panel.",
  proof: [
    { value: 5, label: "networks in one panel" },
    { value: 24, suffix: "/7", label: "comment monitoring" },
    { value: 1, label: "second from comment to DM" },
    { value: 0, label: "scraping or shared passwords" },
  ],
  networksTitle: "Five networks, one control room",
  networksBody:
    "Each network connects through its own official sign-in. Comments, messages, posts and statistics land in one panel, and each platform's rules are applied automatically.",
  networks: {
    instagram: "Comment → DM campaigns, Direct and story triggers, posts, reels and stories, statistics.",
    facebook: "Page comments and Messenger in one place, private replies to comments, posts and reels.",
    threads: "Posts and carousels, reply moderation, statistics.",
    youtube: "Videos and Shorts, comment moderation, statistics.",
    telegram: "Channel posts, discussion comments, channel messages and Business chats.",
  },
  modulesTitle: "From comment to sale — on one platform",
  modulesBody:
    "Campaigns, AI replies, the content plan, the CRM and ads are wired together: whoever comments becomes a contact, and their reply and click show up in the report.",
  modules: [
    {
      icon: "megaphone",
      title: "Comment → DM campaigns",
      body: "A keyword, a public reply and a DM per post or reel. The DM carries a link or a file, and clicks are counted.",
    },
    {
      icon: "sparkles",
      title: "JavobAI",
      body: "Answers comments and messages from your knowledge base. It observes first, then drafts, and replies on its own only once it has proven accurate.",
    },
    {
      icon: "activity",
      title: "Instagram triggers",
      body: "Direct messages, messages from ads, ig.me links, story mentions, story replies and live comments.",
    },
    {
      icon: "share",
      title: "Flow Builder",
      body: "Multi-step DM flows: start from a template or an AI draft, test them and keep every version.",
    },
    {
      icon: "calendar",
      title: "Content plan",
      body: "Plan and publish posts, reels, videos and carousels to five networks from one calendar.",
    },
    {
      icon: "trending",
      title: "Content intelligence",
      body: "Every post is scored against the account's 30-day median. A weekly report and a two-week plan with Reel scenarios.",
    },
    {
      icon: "users",
      title: "CRM",
      body: "Everyone who comments or writes becomes a contact: stage, tags, segments and broadcasts.",
    },
    {
      icon: "inbox",
      title: "AI assistant and leads",
      body: "The assistant collects leads in the chat and sends them to Telegram, amoCRM or Bitrix24. CSV export included.",
    },
    {
      icon: "chart",
      title: "Ads",
      body: "The AI suggests boosting a post that did twice the median. Every spend happens only with your approval.",
    },
    {
      icon: "home",
      title: "Giveaways and points",
      body: "Run giveaways through comments, check the entry rules and reward active followers with points.",
    },
    {
      icon: "list",
      title: "Analytics and reports",
      body: "Campaign, AI, sales and funnel metrics. A report link your client opens without signing in.",
    },
    {
      icon: "plug",
      title: "Webhooks and ManyChat migration",
      body: "Send events to your own system with webhooks. Move your ManyChat work over with a guided wizard.",
    },
  ],
  sampleData: "The picture shows sample data.",
  useCasesTitle: "Every business has its keyword",
  useCasesBody:
    "Start from a ready template: the keyword, the reply text and the tracked link are already written, you only make them yours.",
  useCases: [
    {
      title: "Online store",
      who: "Selling through Instagram and Telegram",
      body: "People ask for the price under a reel — each gets the price and the product link by DM, clicks are counted and the buyer lands in the CRM.",
      flow: ['Comment: "price"', "DM: price and link", "Result: click and lead"],
      cta: "See the template",
      href: "/templates/dtc-product-link",
    },
    {
      title: "Courses and experts",
      who: "Running webinars, challenges and consultations",
      body: "Whoever comments \"class\" gets the sign-up link. JavobAI answers the follow-up questions from the knowledge base.",
      flow: ['Comment: "class"', "DM: sign-up link", "Result: webinar attendee"],
      cta: "See the template",
      href: "/templates/course-webinar",
    },
    {
      title: "Local services",
      who: "Beauty salons, restaurants and local businesses",
      body: "The price list, the menu and the booking link go out at once. The content plan publishes ahead, and the AI handles the repeat questions.",
      flow: ['Comment: "book"', "DM: prices and booking", "Result: a booked slot"],
      cta: "See the template",
      href: "/templates/beauty-price-list",
    },
    {
      title: "Agencies",
      who: "Running several client accounts",
      body: "Each client with their own account and team roles. The client gets a report without signing in: sends, clicks and CTR.",
      flow: ["Client account", "Campaigns and content", "Shareable report"],
      cta: "For agencies",
      href: "/instagram-dm-automation-agencies",
    },
  ],
  trustExtra: [
    {
      title: "AI works with permission",
      body: "JavobAI first only observes, then writes drafts you approve. It moves to replying on its own only after it proves accurate, and one switch stops it.",
    },
    {
      title: "Ad budget under control",
      body: "The AI only proposes: every launch is your click, within a daily and a monthly cap. If the cost per lead climbs, the ad pauses itself.",
    },
  ],
  compareTitle: "How it differs from a chatbot builder",
  compareBody:
    "Broad chatbot platforms can do a lot, but setting them up takes time. SocialAuto keeps the path short: keyword, post, reply, link, result.",
  compareHead: { need: "Need", ours: "SocialAuto", other: "Typical chatbot builder" },
  compareRows: [
    {
      label: "Launch",
      ours: "From a template in minutes: keyword, reply and link ready.",
      other: "Draw and test the flow from scratch.",
    },
    {
      label: "Language",
      ours: "Interface in Uzbek (Latin and Cyrillic), Russian and English.",
      other: "Uzbek is often missing.",
    },
    {
      label: "Content",
      ours: "Content plan and post analysis in the same panel.",
      other: "Messages only, posts need a separate tool.",
    },
    {
      label: "Reporting",
      ours: "Clicks, CTR and a shareable client report link.",
      other: "Conversation stats you clean up for the client.",
    },
    {
      label: "Switching",
      ours: "A ManyChat migration wizard walks you through it.",
      other: "Rebuild everything by hand.",
    },
  ],
  compareLink: "More on the ManyChat alternative",
  faqs: [
    {
      question: "Which networks are supported?",
      answer:
        "Instagram (comment → DM, Direct, story triggers, publishing), Facebook Pages (comments, Messenger, publishing), Threads and YouTube (publishing, comment moderation, statistics) and Telegram channels (posts, discussion comments, channel messages).",
    },
    {
      question: "Can the AI send a wrong answer?",
      answer:
        "On every account JavobAI starts in observe mode, then writes drafts you approve. A reply with a price or number that is not in the knowledge base is not sent; it comes to you as a draft. The autonomous mode turns on only after accuracy is proven.",
    },
    {
      question: "Can ad money get spent on its own?",
      answer:
        "No. The AI only proposes, and you press launch. Daily and monthly caps apply, the ad pauses when the cost per lead goes over your limit, and everything is created paused on Meta's side.",
    },
    {
      question: "Can I move over from ManyChat?",
      answer:
        "Yes. The migration wizard takes you step by step: you review every step and launch it yourself when it is ready.",
    },
    {
      question: "Is the interface available in Uzbek?",
      answer:
        "Yes. The site and the panel work in Uzbek (Latin and Cyrillic), Russian and English, and the language switches on every page.",
    },
  ],
};

export const LANDING: Record<Locale, LandingCopy> = { uz, ru, en };
