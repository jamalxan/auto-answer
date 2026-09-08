import type { SeoPageConfig } from "@/components/seo-page-shell";
import type { Locale } from "@/lib/i18n/config";

const templateLinksByLocale: Record<Locale, SeoPageConfig["templateLinks"]> = {
  en: [
    { label: "DTC product link template", href: "/templates/dtc-product-link" },
    { label: "Real estate lead form template", href: "/templates/real-estate-lead-form" },
    { label: "Fitness plan template", href: "/templates/fitness-plan" },
    { label: "Browse every template", href: "/templates" },
  ],
  ru: [
    { label: "Шаблон ссылки на товар DTC", href: "/templates/dtc-product-link" },
    { label: "Шаблон формы лида для недвижимости", href: "/templates/real-estate-lead-form" },
    { label: "Шаблон фитнес-плана", href: "/templates/fitness-plan" },
    { label: "Смотреть все шаблоны", href: "/templates" },
  ],
  uz: [
    { label: "DTC mahsulot havolasi shabloni", href: "/templates/dtc-product-link" },
    { label: "Ko'chmas mulk lid formasi shabloni", href: "/templates/real-estate-lead-form" },
    { label: "Fitnes reja shabloni", href: "/templates/fitness-plan" },
    { label: "Barcha shablonlarni ko'rish", href: "/templates" },
  ],
};

const manychatAlternativePageByLocale: Record<Locale, SeoPageConfig> = {
  en: {
    eyebrow: "Manychat alternative",
    title: "A focused Manychat alternative for Instagram comment-to-DM campaigns",
    description:
      "SocialAuto is for teams that do not need a broad chatbot builder. It turns keyword comments into Meta-compliant private replies, tracked links, campaign analytics, and client reports.",
    primaryCta: "Try the focused alternative",
    bullets: [
      "Built around Instagram comments, posts, reels, and private replies.",
      "Official Meta API flow with no scraping or password sharing.",
      "Campaign templates, tracked links, and shareable client reports.",
      "Multi-account workspaces with hosted reliability for agencies.",
    ],
    sections: [
      {
        title: "Narrower by design",
        body: "Broad automation suites can be powerful, but they also add flow-builder weight. SocialAuto keeps the campaign path tight: keyword, post, reply, link, result.",
      },
      {
        title: "Agency proof",
        body: "Tracked links and shareable reports make it easier to show clients what happened after the comment, not just that a message was sent.",
      },
      {
        title: "Meta-first delivery",
        body: "Comment events are processed through webhooks, queued, deduped, checked against limits, and sent as private replies using the comment ID.",
      },
    ],
    comparisonTitle: "SocialAuto vs broad chatbot builders",
    comparisons: [
      {
        label: "Setup",
        ours: "Create a keyword campaign for a specific post or reel.",
        other: "Build and maintain a larger chatbot automation flow.",
      },
      {
        label: "Reporting",
        ours: "Campaign-level sends, skips, failures, clicks, CTR, and client report links.",
        other: "Usually broader conversation analytics that need cleanup for client reporting.",
      },
      {
        label: "Positioning",
        ours: "Instagram Campaign OS for agencies and campaign teams.",
        other: "General DM automation across many channels and use cases.",
      },
    ],
    templateLinks: templateLinksByLocale.en,
    faqs: [
      {
        title: "Is SocialAuto a full Manychat replacement?",
        body: "No. SocialAuto is intentionally focused on Instagram comment-to-DM campaigns. If you need a complete chatbot suite, use a broad platform. If you need fast campaign loops, SocialAuto is built for that.",
      },
      {
        title: "Does it support agencies?",
        body: "Yes. It supports multiple Instagram accounts, workspace members, account filters, analytics, and shareable reports, with no account limit.",
      },
    ],
  },
  ru: {
    eyebrow: "Альтернатива Manychat",
    title: "Целевая альтернатива Manychat для Instagram-кампаний «комментарий → DM»",
    description:
      "SocialAuto создан для команд, которым не нужен громоздкий конструктор чат-ботов. Он превращает комментарии с ключевыми словами в личные ответы по правилам Meta, отслеживаемые ссылки, аналитику кампаний и отчёты для клиентов.",
    primaryCta: "Попробовать целевую альтернативу",
    bullets: [
      "Построен вокруг комментариев, постов, рилсов и личных ответов Instagram.",
      "Официальный поток Meta API без скрапинга и передачи паролей.",
      "Шаблоны кампаний, отслеживаемые ссылки и отчёты для клиентов.",
      "Мультиаккаунтные рабочие пространства с надёжным хостингом для агентств.",
    ],
    sections: [
      {
        title: "Узкая специализация — осознанно",
        body: "Широкие пакеты автоматизации мощны, но добавляют лишний вес конструктора потоков. SocialAuto держит путь кампании простым: ключевое слово, пост, ответ, ссылка, результат.",
      },
      {
        title: "Доказательства для агентств",
        body: "Отслеживаемые ссылки и отчёты, которыми можно поделиться, упрощают демонстрацию клиентам того, что произошло после комментария, а не просто факта отправки сообщения.",
      },
      {
        title: "Доставка в приоритете Meta",
        body: "События комментариев обрабатываются через webhook, ставятся в очередь, дедуплицируются, проверяются на лимиты и отправляются как личные ответы по ID комментария.",
      },
    ],
    comparisonTitle: "SocialAuto против широких конструкторов чат-ботов",
    comparisons: [
      {
        label: "Настройка",
        ours: "Создайте кампанию с ключевым словом для конкретного поста или рилса.",
        other: "Стройте и поддерживайте более крупный поток автоматизации чат-бота.",
      },
      {
        label: "Отчётность",
        ours: "Отправки, пропуски, ошибки, клики, CTR и ссылки на клиентские отчёты на уровне кампании.",
        other: "Обычно более широкая аналитика переписки, которую нужно чистить для отчётов клиентам.",
      },
      {
        label: "Позиционирование",
        ours: "Campaign OS для Instagram — для агентств и команд кампаний.",
        other: "Общая автоматизация DM для множества каналов и сценариев.",
      },
    ],
    templateLinks: templateLinksByLocale.ru,
    faqs: [
      {
        title: "SocialAuto — это полная замена Manychat?",
        body: "Нет. SocialAuto намеренно сфокусирован на Instagram-кампаниях «комментарий → DM». Если нужен полноценный пакет чат-ботов, используйте более широкую платформу. Если нужны быстрые циклы кампаний — SocialAuto создан именно для этого.",
      },
      {
        title: "Подходит ли он для агентств?",
        body: "Да. Поддерживает несколько аккаунтов Instagram, участников рабочего пространства, фильтры по аккаунтам, аналитику и отчёты для клиентов — без ограничения по числу аккаунтов.",
      },
    ],
  },
  uz: {
    eyebrow: "Manychat alternativasi",
    title: "Instagram \"izoh → DM\" kampaniyalari uchun maqsadli Manychat alternativasi",
    description:
      "SocialAuto keng chatbot quruvchisiga muhtoj bo'lmagan jamoalar uchun. U kalit so'zli izohlarni Meta talablariga mos shaxsiy javoblarga, kuzatiluvchi havolalarga, kampaniya tahliliga va mijoz hisobotlariga aylantiradi.",
    primaryCta: "Maqsadli alternativani sinab ko'ring",
    bullets: [
      "Instagram izohlari, postlar, rilslar va shaxsiy javoblar atrofida qurilgan.",
      "Skrayping yoki parol almashishsiz rasmiy Meta API oqimi.",
      "Kampaniya shablonlari, kuzatiluvchi havolalar va mijozlarga ulashiladigan hisobotlar.",
      "Agentliklar uchun ishonchli hostingli ko'p akkauntli ish maydonlari.",
    ],
    sections: [
      {
        title: "Ataylab tor doirali",
        body: "Keng avtomatlashtirish paketlari kuchli bo'lishi mumkin, lekin ular oqim quruvchisining og'irligini ham qo'shadi. SocialAuto kampaniya yo'lini qisqa saqlaydi: kalit so'z, post, javob, havola, natija.",
      },
      {
        title: "Agentliklar uchun dalil",
        body: "Kuzatiluvchi havolalar va ulashiladigan hisobotlar mijozlarga izohdan keyin nima bo'lganini ko'rsatishni osonlashtiradi — shunchaki xabar yuborilgani emas.",
      },
      {
        title: "Meta-birinchi yetkazib berish",
        body: "Izoh hodisalari webhook orqali qayta ishlanadi, navbatga qo'yiladi, takrorlanishlar chiqarib tashlanadi, limitlar tekshiriladi va izoh ID'si orqali shaxsiy javob sifatida yuboriladi.",
      },
    ],
    comparisonTitle: "SocialAuto keng chatbot quruvchilariga qarshi",
    comparisons: [
      {
        label: "Sozlash",
        ours: "Aniq bir post yoki rils uchun kalit so'zli kampaniya yarating.",
        other: "Kattaroq chatbot avtomatlashtirish oqimini qurish va qo'llab-quvvatlash.",
      },
      {
        label: "Hisobot",
        ours: "Kampaniya darajasidagi yuborishlar, o'tkazib yuborishlar, xatolar, bosishlar, CTR va mijoz hisobot havolalari.",
        other: "Odatda mijozlarga hisobot berish uchun tozalash talab qiladigan kengroq suhbat tahlili.",
      },
      {
        label: "Pozitsiyalash",
        ours: "Agentliklar va kampaniya jamoalari uchun Instagram Campaign OS.",
        other: "Ko'plab kanallar va foydalanish holatlari bo'yicha umumiy DM avtomatlashtirish.",
      },
    ],
    templateLinks: templateLinksByLocale.uz,
    faqs: [
      {
        title: "SocialAuto Manychat'ning to'liq o'rnini bosadimi?",
        body: "Yo'q. SocialAuto ataylab Instagram \"izoh → DM\" kampaniyalariga qaratilgan. Agar sizga to'liq chatbot paketi kerak bo'lsa, kengroq platformadan foydalaning. Agar tezkor kampaniya sikllari kerak bo'lsa, SocialAuto aynan shu uchun yaratilgan.",
      },
      {
        title: "U agentliklarni qo'llab-quvvatlaydimi?",
        body: "Ha. Bir nechta Instagram akkauntlari, ish maydoni a'zolari, akkaunt filtrlari, tahlil va ulashiladigan hisobotlarni akkaunt cheklovisiz qo'llab-quvvatlaydi.",
      },
    ],
  },
};

const templatesSeoPageByLocale: Record<Locale, SeoPageConfig> = {
  en: {
    eyebrow: "Instagram comment-to-DM templates",
    title: "Instagram comment-to-DM templates for high-intent campaign replies",
    description:
      "Start with proven campaign patterns for product links, lead magnets, price replies, launch waitlists, coaching offers, events, and local services.",
    primaryCta: "Use a template",
    bullets: [
      "Template intent carries into signup and campaign creation.",
      "Each template includes keywords, a campaign goal, and reply copy.",
      "Tracked links turn template replies into measurable clicks.",
      "Agencies can reuse templates across client accounts.",
    ],
    sections: [
      {
        title: "Product link drops",
        body: "Use LINK, SHOP, BUY, or SIZE comments to send exact product pages, launch bundles, or collection links.",
      },
      {
        title: "Lead magnets",
        body: "Use GUIDE, CHECKLIST, PLAN, or START comments to send free resources and follow-up offers.",
      },
      {
        title: "Local services",
        body: "Use PRICE, BOOK, INFO, or TOUR comments to deliver booking links, quote forms, and local offer pages.",
      },
    ],
    comparisonTitle: "Template campaigns vs manual inbox replies",
    comparisons: [
      {
        label: "Speed",
        ours: "Launch from reusable campaign templates in minutes.",
        other: "Reply manually or rebuild the same campaign copy each time.",
      },
      {
        label: "Measurement",
        ours: "Use tracked links and keyword analytics per campaign.",
        other: "Rely on screenshots, inbox memory, or scattered link data.",
      },
      {
        label: "Reuse",
        ours: "Clone the same playbook across posts, reels, and client accounts.",
        other: "Repeat setup work for every campaign.",
      },
    ],
    templateLinks: templateLinksByLocale.en,
    faqs: [
      {
        title: "Can I edit the template copy?",
        body: "Yes. Templates are starting points. You can change keywords, private reply text, tracked destination URLs, and active status before launching.",
      },
      {
        title: "Do templates work for reels?",
        body: "Yes. Campaigns can target Instagram posts or reels returned by the connected professional account.",
      },
    ],
  },
  ru: {
    eyebrow: "Шаблоны «комментарий → DM» для Instagram",
    title: "Шаблоны «комментарий → DM» для Instagram под ответы с высоким намерением",
    description:
      "Начните с проверенных сценариев кампаний для ссылок на товары, лид-магнитов, ответов с ценами, листов ожидания запуска, коучинговых предложений, событий и локальных услуг.",
    primaryCta: "Использовать шаблон",
    bullets: [
      "Намерение шаблона переносится в регистрацию и создание кампании.",
      "Каждый шаблон включает ключевые слова, цель кампании и текст ответа.",
      "Отслеживаемые ссылки превращают ответы шаблона в измеримые клики.",
      "Агентства могут переиспользовать шаблоны на разных клиентских аккаунтах.",
    ],
    sections: [
      {
        title: "Выдача ссылок на товары",
        body: "Используйте комментарии LINK, SHOP, BUY или SIZE, чтобы отправлять точные страницы товаров, наборы запуска или ссылки на коллекции.",
      },
      {
        title: "Лид-магниты",
        body: "Используйте комментарии GUIDE, CHECKLIST, PLAN или START, чтобы отправлять бесплатные материалы и последующие предложения.",
      },
      {
        title: "Локальные услуги",
        body: "Используйте комментарии PRICE, BOOK, INFO или TOUR, чтобы доставлять ссылки на бронирование, формы запроса цены и страницы локальных предложений.",
      },
    ],
    comparisonTitle: "Кампании по шаблонам против ручных ответов в директ",
    comparisons: [
      {
        label: "Скорость",
        ours: "Запускайте кампании из готовых шаблонов за минуты.",
        other: "Отвечайте вручную или каждый раз заново собирайте тот же текст кампании.",
      },
      {
        label: "Измерение",
        ours: "Используйте отслеживаемые ссылки и аналитику ключевых слов по каждой кампании.",
        other: "Полагайтесь на скриншоты, память переписки или разрозненные данные о ссылках.",
      },
      {
        label: "Переиспользование",
        ours: "Клонируйте один и тот же сценарий на разные посты, рилсы и клиентские аккаунты.",
        other: "Повторяйте настройку для каждой новой кампании.",
      },
    ],
    templateLinks: templateLinksByLocale.ru,
    faqs: [
      {
        title: "Можно ли редактировать текст шаблона?",
        body: "Да. Шаблоны — это отправная точка. Перед запуском можно изменить ключевые слова, текст личного ответа, отслеживаемые URL назначения и статус активности.",
      },
      {
        title: "Работают ли шаблоны для рилсов?",
        body: "Да. Кампании могут нацеливаться на посты или рилсы Instagram, полученные от подключённого профессионального аккаунта.",
      },
    ],
  },
  uz: {
    eyebrow: "Instagram \"izoh → DM\" shablonlari",
    title: "Yuqori qiziqishli javoblar uchun Instagram \"izoh → DM\" shablonlari",
    description:
      "Mahsulot havolalari, lid-magnitlar, narx javoblari, ishga tushirish kutish ro'yxatlari, koching takliflari, tadbirlar va mahalliy xizmatlar uchun sinovdan o'tgan kampaniya naqshlaridan boshlang.",
    primaryCta: "Shablondan foydalanish",
    bullets: [
      "Shablon maqsadi ro'yxatdan o'tish va kampaniya yaratishga o'tadi.",
      "Har bir shablonda kalit so'zlar, kampaniya maqsadi va javob matni bor.",
      "Kuzatiluvchi havolalar shablon javoblarini o'lchanadigan bosishlarga aylantiradi.",
      "Agentliklar shablonlarni turli mijoz akkauntlarida qayta ishlatishlari mumkin.",
    ],
    sections: [
      {
        title: "Mahsulot havolasi tarqatish",
        body: "Aniq mahsulot sahifalari, ishga tushirish to'plamlari yoki kolleksiya havolalarini yuborish uchun LINK, SHOP, BUY yoki SIZE izohlaridan foydalaning.",
      },
      {
        title: "Lid-magnitlar",
        body: "Bepul resurslar va keyingi takliflarni yuborish uchun GUIDE, CHECKLIST, PLAN yoki START izohlaridan foydalaning.",
      },
      {
        title: "Mahalliy xizmatlar",
        body: "Bron havolalari, narx so'rash formalari va mahalliy taklif sahifalarini yetkazish uchun PRICE, BOOK, INFO yoki TOUR izohlaridan foydalaning.",
      },
    ],
    comparisonTitle: "Shablon kampaniyalari qo'lda yozilgan javoblarga qarshi",
    comparisons: [
      {
        label: "Tezlik",
        ours: "Qayta ishlatiladigan kampaniya shablonlaridan bir necha daqiqada ishga tushiring.",
        other: "Qo'lda javob bering yoki har safar bir xil kampaniya matnini qaytadan yig'ing.",
      },
      {
        label: "O'lchash",
        ours: "Har bir kampaniya uchun kuzatiluvchi havolalar va kalit so'z tahlilidan foydalaning.",
        other: "Skrinshotlar, xotira yoki tarqoq havola ma'lumotlariga tayaning.",
      },
      {
        label: "Qayta foydalanish",
        ours: "Bir xil ssenariyni postlar, rilslar va mijoz akkauntlari bo'ylab klonlang.",
        other: "Har bir kampaniya uchun sozlash ishlarini takrorlang.",
      },
    ],
    templateLinks: templateLinksByLocale.uz,
    faqs: [
      {
        title: "Shablon matnini tahrirlash mumkinmi?",
        body: "Ha. Shablonlar — bu boshlang'ich nuqta. Ishga tushirishdan oldin kalit so'zlar, shaxsiy javob matni, kuzatiluvchi manzil URL'lari va faollik holatini o'zgartirishingiz mumkin.",
      },
      {
        title: "Shablonlar rilslar uchun ishlaydimi?",
        body: "Ha. Kampaniyalar ulangan professional akkauntdan olingan Instagram postlari yoki rilslariga qaratilishi mumkin.",
      },
    ],
  },
};

const agenciesSeoPageByLocale: Record<Locale, SeoPageConfig> = {
  en: {
    eyebrow: "Instagram DM automation for agencies",
    title: "Instagram DM automation for agencies managing client campaigns",
    description:
      "SocialAuto gives agencies multi-account workspaces, client-ready reports, tracked links, and a focused comment-to-DM workflow for repeatable Instagram campaigns.",
    primaryCta: "Start an agency workspace",
    bullets: [
      "Connect multiple client Instagram accounts on the Agency plan.",
      "Filter dashboards, logs, campaigns, and settings by account.",
      "Invite teammates as owners, admins, or members.",
      "Share read-only client reports without exposing workspace controls.",
    ],
    sections: [
      {
        title: "Client separation",
        body: "Account filters keep campaign creation, logs, and reporting cleaner when one workspace manages multiple brands.",
      },
      {
        title: "Repeatable offers",
        body: "Use templates to package lead magnets, product drops, price replies, and launch waitlists as repeatable agency services.",
      },
      {
        title: "Proof of work",
        body: "Shareable reports show sends, skips, failures, clicks, CTR, top keywords, and tracked links in a client-safe view.",
      },
    ],
    comparisonTitle: "Agency workflow vs generic automation",
    comparisons: [
      {
        label: "Client reporting",
        ours: "Public read-only campaign report links, with no plan gating.",
        other: "Manual screenshots or dashboards that expose too much internal workspace context.",
      },
      {
        label: "Team roles",
        ours: "Owner, admin, and member roles with invite links.",
        other: "Often one shared login or overpowered teammate access.",
      },
      {
        label: "Account operations",
        ours: "Per-account filters for campaigns, logs, dashboard stats, and settings.",
        other: "Client work can get mixed across broad automation workspaces.",
      },
    ],
    templateLinks: templateLinksByLocale.en,
    faqs: [
      {
        title: "How many Instagram accounts can agencies connect?",
        body: "The Agency plan is shaped for up to 10 connected Instagram professional accounts in the current launch packaging.",
      },
      {
        title: "Can clients see reports without logging in?",
        body: "Yes. Shareable report pages are public read-only links that hide private workspace controls and DM copy.",
      },
    ],
  },
  ru: {
    eyebrow: "Автоматизация DM Instagram для агентств",
    title: "Автоматизация DM Instagram для агентств, управляющих клиентскими кампаниями",
    description:
      "SocialAuto даёт агентствам мультиаккаунтные рабочие пространства, готовые для клиентов отчёты, отслеживаемые ссылки и целевой рабочий процесс «комментарий → DM» для повторяемых кампаний в Instagram.",
    primaryCta: "Создать рабочее пространство агентства",
    bullets: [
      "Подключайте несколько клиентских аккаунтов Instagram на тарифе Agency.",
      "Фильтруйте панель, журналы, кампании и настройки по аккаунту.",
      "Приглашайте коллег как владельцев, администраторов или участников.",
      "Делитесь клиентскими отчётами только для чтения, не раскрывая управление рабочим пространством.",
    ],
    sections: [
      {
        title: "Разделение клиентов",
        body: "Фильтры по аккаунту делают создание кампаний, журналы и отчётность чище, когда одно рабочее пространство управляет несколькими брендами.",
      },
      {
        title: "Повторяемые предложения",
        body: "Используйте шаблоны, чтобы упаковать лид-магниты, выдачи товаров, ответы с ценами и листы ожидания запуска как повторяемые услуги агентства.",
      },
      {
        title: "Доказательство работы",
        body: "Отчёты, которыми можно поделиться, показывают отправки, пропуски, ошибки, клики, CTR, топ ключевых слов и отслеживаемые ссылки в безопасном для клиента виде.",
      },
    ],
    comparisonTitle: "Рабочий процесс агентства против обычной автоматизации",
    comparisons: [
      {
        label: "Отчётность клиентам",
        ours: "Публичные ссылки на отчёты по кампаниям только для чтения, без ограничений тарифа.",
        other: "Ручные скриншоты или панели, раскрывающие слишком много внутреннего контекста рабочего пространства.",
      },
      {
        label: "Роли команды",
        ours: "Роли владельца, администратора и участника со ссылками-приглашениями.",
        other: "Часто один общий логин или чрезмерный доступ у коллег.",
      },
      {
        label: "Операции по аккаунтам",
        ours: "Фильтры по каждому аккаунту для кампаний, журналов, статистики панели и настроек.",
        other: "Работа с клиентами может смешиваться в широких рабочих пространствах автоматизации.",
      },
    ],
    templateLinks: templateLinksByLocale.ru,
    faqs: [
      {
        title: "Сколько аккаунтов Instagram могут подключить агентства?",
        body: "Тариф Agency рассчитан на до 10 подключённых профессиональных аккаунтов Instagram в текущей упаковке запуска.",
      },
      {
        title: "Могут ли клиенты видеть отчёты без входа в систему?",
        body: "Да. Страницы отчётов, которыми можно поделиться, — это публичные ссылки только для чтения, скрывающие приватное управление рабочим пространством и текст DM.",
      },
    ],
  },
  uz: {
    eyebrow: "Agentliklar uchun Instagram DM avtomatlashtirish",
    title: "Mijoz kampaniyalarini boshqaradigan agentliklar uchun Instagram DM avtomatlashtirish",
    description:
      "SocialAuto agentliklarga ko'p akkauntli ish maydonlari, mijozga tayyor hisobotlar, kuzatiluvchi havolalar va takrorlanadigan Instagram kampaniyalari uchun maqsadli \"izoh → DM\" ish jarayonini beradi.",
    primaryCta: "Agentlik ish maydonini boshlash",
    bullets: [
      "Agency tarifida bir nechta mijoz Instagram akkauntlarini ulang.",
      "Boshqaruv paneli, jurnallar, kampaniyalar va sozlamalarni akkaunt bo'yicha filtrlang.",
      "Hamkasblarni egasi, admin yoki a'zo sifatida taklif qiling.",
      "Ish maydoni boshqaruvini oshkor qilmasdan, faqat o'qish uchun mijoz hisobotlarini ulashing.",
    ],
    sections: [
      {
        title: "Mijozlarni ajratish",
        body: "Bitta ish maydoni bir nechta brendni boshqarganda, akkaunt filtrlari kampaniya yaratish, jurnallar va hisobotni tozaroq qiladi.",
      },
      {
        title: "Takrorlanadigan takliflar",
        body: "Lid-magnitlar, mahsulot chiqarishlari, narx javoblari va ishga tushirish kutish ro'yxatlarini takrorlanadigan agentlik xizmatlari sifatida qadoqlash uchun shablonlardan foydalaning.",
      },
      {
        title: "Ish natijasi dalili",
        body: "Ulashiladigan hisobotlar yuborishlar, o'tkazib yuborishlar, xatolar, bosishlar, CTR, top kalit so'zlar va kuzatiluvchi havolalarni mijoz uchun xavfsiz ko'rinishda ko'rsatadi.",
      },
    ],
    comparisonTitle: "Agentlik ish jarayoni oddiy avtomatlashtirishga qarshi",
    comparisons: [
      {
        label: "Mijozga hisobot berish",
        ours: "Tarif cheklovisiz, ommaviy, faqat o'qish uchun kampaniya hisobot havolalari.",
        other: "Ish maydonining ichki kontekstini haddan tashqari oshkor qiladigan qo'lda skrinshotlar yoki panellar.",
      },
      {
        label: "Jamoa rollari",
        ours: "Taklif havolalari bilan egasi, admin va a'zo rollari.",
        other: "Ko'pincha bitta umumiy login yoki hamkasblarga ortiqcha kirish huquqi.",
      },
      {
        label: "Akkaunt amaliyotlari",
        ours: "Kampaniyalar, jurnallar, boshqaruv paneli statistikasi va sozlamalar uchun har bir akkaunt bo'yicha filtrlar.",
        other: "Mijoz ishi keng avtomatlashtirish ish maydonlarida aralashib ketishi mumkin.",
      },
    ],
    templateLinks: templateLinksByLocale.uz,
    faqs: [
      {
        title: "Agentliklar nechta Instagram akkauntini ulashi mumkin?",
        body: "Agency tarifi hozirgi ishga tushirish paketida 10 tagacha ulangan Instagram professional akkauntlari uchun mo'ljallangan.",
      },
      {
        title: "Mijozlar tizimga kirmasdan hisobotlarni ko'ra oladimi?",
        body: "Ha. Ulashiladigan hisobot sahifalari — bu shaxsiy ish maydoni boshqaruvi va DM matnini yashiradigan, ommaviy, faqat o'qish uchun havolalar.",
      },
    ],
  },
};

const commentLinkSeoPageByLocale: Record<Locale, SeoPageConfig> = {
  en: {
    eyebrow: "Comment LINK automation",
    title: "Comment LINK automation for Instagram posts and reels",
    description:
      "Let followers comment LINK, SHOP, GUIDE, or any keyword and receive the right private reply with a tracked destination URL.",
    primaryCta: "Automate comment LINK",
    bullets: [
      "Match exact keywords or whole-word phrases.",
      "Send Meta-compliant private replies from the triggering comment.",
      "Insert tracked links into replies with click analytics.",
      "Deduplicate comment jobs and log sent, skipped, and failed outcomes.",
    ],
    sections: [
      {
        title: "For product links",
        body: "Turn high-intent LINK comments into tracked visits to product pages, landing pages, waitlists, or checkout offers.",
      },
      {
        title: "For creator offers",
        body: "Send guides, free resources, course links, and coaching applications without manually watching the inbox.",
      },
      {
        title: "For launch spikes",
        body: "Queue and process campaign replies while a reel is getting attention, with plan and rate-limit checks in the worker.",
      },
    ],
    comparisonTitle: "Comment LINK automation vs manual link replies",
    comparisons: [
      {
        label: "Reply accuracy",
        ours: "Every matched comment gets the campaign reply tied to that post or reel.",
        other: "Manual replies are easy to miss when comments spike.",
      },
      {
        label: "Tracking",
        ours: "Tracked links connect private replies to click outcomes.",
        other: "Regular pasted links rarely show campaign-level performance.",
      },
      {
        label: "Compliance",
        ours: "Built around official private reply semantics and rate-aware queues.",
        other: "Unsafe browser automation or scraping can put accounts at risk.",
      },
    ],
    templateLinks: templateLinksByLocale.en,
    faqs: [
      {
        title: "Can I use keywords other than LINK?",
        body: "Yes. Each campaign can use multiple keywords such as PRICE, SHOP, GUIDE, PLAN, WAITLIST, TOUR, or your own phrase.",
      },
      {
        title: "Does SocialAuto send a normal Instagram DM?",
        body: "It sends a Meta-compliant private reply triggered by the comment event, using the Instagram comment ID.",
      },
    ],
  },
  ru: {
    eyebrow: "Автоматизация комментария LINK",
    title: "Автоматизация комментария LINK для постов и рилсов Instagram",
    description:
      "Позвольте подписчикам оставлять комментарий LINK, SHOP, GUIDE или любое ключевое слово и получать нужный личный ответ с отслеживаемым URL назначения.",
    primaryCta: "Автоматизировать комментарий LINK",
    bullets: [
      "Сопоставление точных ключевых слов или целых фраз.",
      "Отправка личных ответов по правилам Meta от вызвавшего комментария.",
      "Вставка отслеживаемых ссылок в ответы с аналитикой кликов.",
      "Дедупликация задач по комментариям и журнал отправленных, пропущенных и неудачных исходов.",
    ],
    sections: [
      {
        title: "Для ссылок на товары",
        body: "Превращайте комментарии LINK с высоким намерением в отслеживаемые переходы на страницы товаров, лендинги, листы ожидания или предложения оформления заказа.",
      },
      {
        title: "Для предложений авторов",
        body: "Отправляйте гайды, бесплатные материалы, ссылки на курсы и заявки на коучинг, не отслеживая входящие вручную.",
      },
      {
        title: "Для всплесков после запуска",
        body: "Ставьте в очередь и обрабатывайте ответы кампании, пока рилс набирает внимание, с проверкой тарифа и лимита скорости в воркере.",
      },
    ],
    comparisonTitle: "Автоматизация комментария LINK против ручных ответов со ссылкой",
    comparisons: [
      {
        label: "Точность ответа",
        ours: "Каждый совпавший комментарий получает ответ кампании, привязанный к этому посту или рилсу.",
        other: "Ручные ответы легко пропустить при всплеске комментариев.",
      },
      {
        label: "Отслеживание",
        ours: "Отслеживаемые ссылки связывают личные ответы с результатами кликов.",
        other: "Обычные вставленные ссылки редко показывают эффективность на уровне кампании.",
      },
      {
        label: "Соответствие правилам",
        ours: "Построено вокруг официальной семантики личных ответов и очередей с учётом лимитов.",
        other: "Небезопасная автоматизация браузера или скрапинг могут поставить аккаунты под угрозу.",
      },
    ],
    templateLinks: templateLinksByLocale.ru,
    faqs: [
      {
        title: "Можно ли использовать другие ключевые слова, кроме LINK?",
        body: "Да. Каждая кампания может использовать несколько ключевых слов, таких как PRICE, SHOP, GUIDE, PLAN, WAITLIST, TOUR или собственную фразу.",
      },
      {
        title: "SocialAuto отправляет обычное DM Instagram?",
        body: "Он отправляет соответствующий правилам Meta личный ответ, вызванный событием комментария, используя ID комментария Instagram.",
      },
    ],
  },
  uz: {
    eyebrow: "Izohga LINK avtomatlashtirish",
    title: "Instagram post va rilslar uchun izohga LINK avtomatlashtirish",
    description:
      "Obunachilar LINK, SHOP, GUIDE yoki istalgan kalit so'zni izoh qoldirsin va kuzatiluvchi manzil URL'i bilan to'g'ri shaxsiy javobni olsin.",
    primaryCta: "Izohga LINK'ni avtomatlashtirish",
    bullets: [
      "Aniq kalit so'zlar yoki to'liq iboralarni moslashtirish.",
      "Trigger bo'lgan izohdan Meta talablariga mos shaxsiy javoblar yuborish.",
      "Bosish tahlili bilan javoblarga kuzatiluvchi havolalarni qo'shish.",
      "Izoh vazifalarini takrorlanishlardan tozalash va yuborilgan, o'tkazib yuborilgan hamda muvaffaqiyatsiz natijalarni jurnalga yozish.",
    ],
    sections: [
      {
        title: "Mahsulot havolalari uchun",
        body: "Yuqori qiziqishli LINK izohlarini mahsulot sahifalari, landing sahifalar, kutish ro'yxatlari yoki checkout takliflariga kuzatiluvchi tashriflarga aylantiring.",
      },
      {
        title: "Kontent-meykerlar takliflari uchun",
        body: "Xabarlar qutisini qo'lda kuzatmasdan, qo'llanmalar, bepul resurslar, kurs havolalari va koching arizalarini yuboring.",
      },
      {
        title: "Ishga tushirish sakrashlari uchun",
        body: "Rils diqqatni tortayotgan paytda, workerda tarif va tezlik chekloviga tekshiruvlar bilan kampaniya javoblarini navbatga qo'ying va qayta ishlang.",
      },
    ],
    comparisonTitle: "Izohga LINK avtomatlashtirish qo'lda havola javoblariga qarshi",
    comparisons: [
      {
        label: "Javob aniqligi",
        ours: "Har bir mos izoh shu post yoki rilsga bog'langan kampaniya javobini oladi.",
        other: "Izohlar keskin ko'paysa, qo'lda javoblarni oson o'tkazib yuborish mumkin.",
      },
      {
        label: "Kuzatish",
        ours: "Kuzatiluvchi havolalar shaxsiy javoblarni bosish natijalari bilan bog'laydi.",
        other: "Oddiy qo'yilgan havolalar kampaniya darajasidagi samaradorlikni kamdan-kam ko'rsatadi.",
      },
      {
        label: "Muvofiqlik",
        ours: "Rasmiy shaxsiy javob semantikasi va tezlikni hisobga oluvchi navbatlar atrofida qurilgan.",
        other: "Xavfsiz bo'lmagan brauzer avtomatlashtirish yoki skrayping akkauntlarni xavf ostiga qo'yishi mumkin.",
      },
    ],
    templateLinks: templateLinksByLocale.uz,
    faqs: [
      {
        title: "LINK'dan boshqa kalit so'zlarni ishlata olamanmi?",
        body: "Ha. Har bir kampaniya PRICE, SHOP, GUIDE, PLAN, WAITLIST, TOUR kabi bir nechta kalit so'zlar yoki o'zingizning iborangizdan foydalanishi mumkin.",
      },
      {
        title: "SocialAuto oddiy Instagram DM yuboradimi?",
        body: "U Instagram izoh ID'sidan foydalanib, izoh hodisasi tomonidan trigger qilingan, Meta talablariga mos shaxsiy javob yuboradi.",
      },
    ],
  },
};

export function getManychatAlternativePage(locale: Locale): SeoPageConfig {
  return manychatAlternativePageByLocale[locale];
}

export function getTemplatesSeoPage(locale: Locale): SeoPageConfig {
  return templatesSeoPageByLocale[locale];
}

export function getAgenciesSeoPage(locale: Locale): SeoPageConfig {
  return agenciesSeoPageByLocale[locale];
}

export function getCommentLinkSeoPage(locale: Locale): SeoPageConfig {
  return commentLinkSeoPageByLocale[locale];
}
