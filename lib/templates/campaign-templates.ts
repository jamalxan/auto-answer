import type { Locale } from "@/lib/i18n/config";

export interface CampaignTemplate {
  slug: string;
  title: string;
  category: string;
  audience: string;
  summary: string;
  goal: string;
  keywords: string[];
  dmMessage: string;
  triggerExample: string;
  privateReplyPreview: string;
  setupMinutes: number;
  outcome: string;
  bestFor: string[];
  playbook: string[];
  metrics: string[];
  accent: "cyan" | "emerald" | "rose" | "amber";
}

// Keywords, sample DM copy, and setup time are locale-independent — they are
// either literal Instagram comment keywords or illustrative example message
// content, not app UI.
interface TemplateBase {
  slug: string;
  keywords: string[];
  dmMessage: string;
  triggerExample: string;
  privateReplyPreview: string;
  setupMinutes: number;
  accent: "cyan" | "emerald" | "rose" | "amber";
}

interface TemplateContent {
  title: string;
  category: string;
  audience: string;
  summary: string;
  goal: string;
  outcome: string;
  bestFor: string[];
  playbook: string[];
  metrics: string[];
}

const TEMPLATE_BASE: TemplateBase[] = [
  {
    slug: "dtc-product-link",
    keywords: ["LINK", "SHOP", "BUY"],
    dmMessage:
      "Hey {username}, here is the product link you asked for: https://yourstore.com/product",
    triggerExample: "LINK please",
    privateReplyPreview:
      "Hey Maya, here is the product link you asked for: yourstore.com/product",
    setupMinutes: 4,
    accent: "cyan",
  },
  {
    slug: "real-estate-lead-form",
    keywords: ["HOME", "LISTING", "VALUE"],
    dmMessage:
      "Hey {username}, here is the form to get the property details and next available showing slots: https://yourlink.com/home",
    triggerExample: "HOME details",
    privateReplyPreview:
      "Hey Jordan, here is the form to get property details and showing slots.",
    setupMinutes: 5,
    accent: "emerald",
  },
  {
    slug: "fitness-plan",
    keywords: ["PLAN", "FIT", "START"],
    dmMessage:
      "Hey {username}, here is the free plan from the reel: https://yourlink.com/fitness-plan",
    triggerExample: "PLAN",
    privateReplyPreview:
      "Hey Sam, here is the free plan from the reel: yourlink.com/fitness-plan",
    setupMinutes: 3,
    accent: "rose",
  },
  {
    slug: "course-webinar",
    keywords: ["WEBINAR", "CLASS", "LEARN"],
    dmMessage:
      "Hey {username}, here is the free class registration link: https://yourlink.com/webinar",
    triggerExample: "WEBINAR",
    privateReplyPreview:
      "Hey Alex, here is the free class registration link: yourlink.com/webinar",
    setupMinutes: 4,
    accent: "amber",
  },
  {
    slug: "beauty-price-list",
    keywords: ["PRICE", "MENU", "BOOK"],
    dmMessage:
      "Hey {username}, here is our service menu and booking link: https://yourlink.com/booking",
    triggerExample: "PRICE",
    privateReplyPreview: "Hey Riley, here is our service menu and booking link.",
    setupMinutes: 4,
    accent: "rose",
  },
  {
    slug: "restaurant-menu",
    keywords: ["MENU", "TABLE", "RESERVE"],
    dmMessage:
      "Hey {username}, here is our menu and reservation link: https://yourlink.com/menu",
    triggerExample: "MENU",
    privateReplyPreview: "Hey Taylor, here is our menu and reservation link.",
    setupMinutes: 3,
    accent: "amber",
  },
  {
    slug: "event-rsvp",
    keywords: ["RSVP", "TICKET", "JOIN"],
    dmMessage:
      "Hey {username}, here is the RSVP link with event details: https://yourlink.com/rsvp",
    triggerExample: "RSVP",
    privateReplyPreview: "Hey Morgan, here is the RSVP link with event details.",
    setupMinutes: 4,
    accent: "emerald",
  },
  {
    slug: "creator-media-kit",
    keywords: ["COLLAB", "KIT", "RATES"],
    dmMessage:
      "Hey {username}, here is my media kit and partnership form: https://yourlink.com/media-kit",
    triggerExample: "COLLAB",
    privateReplyPreview: "Hey Casey, here is my media kit and partnership form.",
    setupMinutes: 4,
    accent: "cyan",
  },
];

const TEMPLATE_CONTENT: Record<Locale, Record<string, TemplateContent>> = {
  en: {
    "dtc-product-link": {
      title: "DTC Product Link Drop",
      category: "Social commerce",
      audience: "DTC brands",
      summary:
        "Turn comments like LINK or SHOP into a private reply with the exact product page, size guide, or launch bundle.",
      goal: "Product link request",
      outcome: "More warm product conversations from high-intent comments.",
      bestFor: ["Product drops", "UGC reels", "Influencer campaigns"],
      playbook: [
        "Pick the reel or post that shows the product clearly.",
        "Use LINK, SHOP, and BUY as the first keywords.",
        "Send a direct product URL with one short benefit line.",
        "Track which product posts create the most sent replies.",
      ],
      metrics: ["Sent replies", "Skipped duplicates", "Product link CTR"],
    },
    "real-estate-lead-form": {
      title: "Real Estate Lead Form",
      category: "Lead generation",
      audience: "Agents and broker teams",
      summary:
        "Send buyers or sellers a valuation form, booking link, or neighborhood guide after they comment on a listing reel.",
      goal: "Lead magnet delivery",
      outcome: "Capture listing interest before it gets buried in comments.",
      bestFor: ["Listing reels", "Neighborhood guides", "Seller valuation posts"],
      playbook: [
        "Choose one property or local-market post.",
        "Use keywords that match buyer intent, not generic emojis.",
        "Send a form that asks for contact details and timing.",
        "Follow up manually with qualified leads from the form.",
      ],
      metrics: ["Lead form opens", "DM sends", "Booked showings"],
    },
    "fitness-plan": {
      title: "Fitness Plan Download",
      category: "Creator funnels",
      audience: "Coaches and fitness creators",
      summary:
        "Deliver a workout plan, macro guide, or coaching intake form when followers comment PLAN, FIT, or START.",
      goal: "Lead magnet delivery",
      outcome: "Move motivated followers into a coaching or email funnel.",
      bestFor: ["Workout reels", "Transformation posts", "Challenge launches"],
      playbook: [
        "Post a reel that shows the result and asks for one keyword.",
        "Keep the DM short and focused on the promised asset.",
        "Add a coaching intake link after the free value.",
        "Review failed and skipped logs after high-traffic reels.",
      ],
      metrics: ["Guide requests", "Challenge signups", "Coaching inquiries"],
    },
    "course-webinar": {
      title: "Course Webinar Invite",
      category: "Education",
      audience: "Course sellers",
      summary:
        "Send webinar registration or lesson links to followers who comment WEBINAR, CLASS, or LEARN on educational posts.",
      goal: "Launch waitlist",
      outcome: "Convert educational reach into webinar and waitlist registrations.",
      bestFor: ["Course launches", "Mini trainings", "Live workshops"],
      playbook: [
        "Attach the campaign to a proof-heavy educational reel.",
        "Use one primary keyword in the caption and two fallback keywords.",
        "Send the registration link with the date or promise.",
        "Use the sent log to compare organic posts before ad spend.",
      ],
      metrics: ["Registrations", "DM sends", "Show-up rate"],
    },
    "beauty-price-list": {
      title: "Beauty Service Price List",
      category: "Local services",
      audience: "Salons, spas, and beauty pros",
      summary:
        "Reply with pricing, booking links, and service menus when people comment PRICE, MENU, or BOOK.",
      goal: "Price or availability reply",
      outcome: "Reduce repetitive comment replies and move buyers toward booking.",
      bestFor: ["Before/after reels", "Service menu posts", "Availability posts"],
      playbook: [
        "Choose a post where people already ask about pricing.",
        "Add a booking link with clear service categories.",
        "Keep the DM compliant and avoid medical or exaggerated claims.",
        "Update the link when pricing or availability changes.",
      ],
      metrics: ["Booking link clicks", "DM sends", "New appointments"],
    },
    "restaurant-menu": {
      title: "Restaurant Menu And Reservation",
      category: "Hospitality",
      audience: "Restaurants and cafes",
      summary:
        "Send menus, reservation links, or event specials when guests comment MENU, TABLE, or RESERVE.",
      goal: "Product link request",
      outcome: "Turn food reels into reservations and menu views.",
      bestFor: ["Specials", "New menu launches", "Weekend reservation pushes"],
      playbook: [
        "Use a high-appetite food reel with a clear comment prompt.",
        "Send a mobile-friendly menu or booking page.",
        "Mention limited seating only when it is true.",
        "Repeat the template for seasonal specials.",
      ],
      metrics: ["Menu clicks", "Reservations", "Weekend campaign replies"],
    },
    "event-rsvp": {
      title: "Event RSVP Campaign",
      category: "Events",
      audience: "Venues, communities, and launch teams",
      summary:
        "Send RSVP forms, calendar links, or ticket pages after someone comments RSVP, TICKET, or JOIN.",
      goal: "Launch waitlist",
      outcome: "Convert event attention into measurable RSVPs.",
      bestFor: ["Popups", "Workshops", "Community events"],
      playbook: [
        "Choose the event announcement or recap reel.",
        "Use RSVP as the main keyword and add ticket-oriented fallbacks.",
        "Send one link that includes date, location, and confirmation.",
        "Pause the campaign after the event ends.",
      ],
      metrics: ["RSVPs", "Ticket clicks", "Replies by event post"],
    },
    "creator-media-kit": {
      title: "Creator Media Kit Reply",
      category: "Creator business",
      audience: "Creators and agencies",
      summary:
        "Send a media kit, rate card, or brand inquiry form when brands comment COLLAB, KIT, or RATES.",
      goal: "Agency client campaign",
      outcome: "Capture brand interest without asking people to search your bio.",
      bestFor: ["Pinned portfolio reels", "Case study posts", "Brand outreach"],
      playbook: [
        "Pin a collaboration post or creator portfolio reel.",
        "Use professional keywords brands naturally comment.",
        "Send a media kit link and one qualification question.",
        "Review DMs weekly and tag qualified opportunities.",
      ],
      metrics: ["Brand inquiries", "Media kit clicks", "Qualified partnership DMs"],
    },
  },
  ru: {
    "dtc-product-link": {
      title: "Выдача ссылки на товар DTC",
      category: "Социальная торговля",
      audience: "DTC-бренды",
      summary:
        "Превратите комментарии вроде LINK или SHOP в личный ответ с точной страницей товара, гидом по размерам или набором запуска.",
      goal: "Запрос ссылки на товар",
      outcome: "Больше тёплых разговоров о товаре из комментариев с высоким намерением.",
      bestFor: ["Выдачи товаров", "UGC-рилсы", "Кампании с инфлюенсерами"],
      playbook: [
        "Выберите рилс или пост, где товар показан чётко.",
        "Используйте LINK, SHOP и BUY как первые ключевые слова.",
        "Отправляйте прямой URL товара с одной короткой строкой о выгоде.",
        "Отслеживайте, какие посты о товарах приносят больше всего отправленных ответов.",
      ],
      metrics: ["Отправленные ответы", "Пропущенные дубликаты", "CTR ссылки на товар"],
    },
    "real-estate-lead-form": {
      title: "Форма лида для недвижимости",
      category: "Генерация лидов",
      audience: "Агенты и брокерские команды",
      summary:
        "Отправляйте покупателям или продавцам форму оценки, ссылку на бронирование показа или гид по району после комментария к рилсу с объявлением.",
      goal: "Доставка лид-магнита",
      outcome: "Захватывайте интерес к объявлению до того, как он потеряется в комментариях.",
      bestFor: ["Рилсы с объявлениями", "Гиды по районам", "Посты об оценке от продавца"],
      playbook: [
        "Выберите один объект или пост о местном рынке.",
        "Используйте ключевые слова, отражающие намерение покупателя, а не общие эмодзи.",
        "Отправляйте форму, запрашивающую контакты и удобное время.",
        "Обрабатывайте квалифицированные лиды из формы вручную.",
      ],
      metrics: ["Открытия формы лида", "Отправки DM", "Забронированные показы"],
    },
    "fitness-plan": {
      title: "Скачивание фитнес-плана",
      category: "Воронки для авторов",
      audience: "Тренеры и фитнес-авторы",
      summary:
        "Отправляйте план тренировок, гид по КБЖУ или анкету на коучинг, когда подписчики комментируют PLAN, FIT или START.",
      goal: "Доставка лид-магнита",
      outcome: "Переводите мотивированных подписчиков в воронку коучинга или email.",
      bestFor: ["Рилсы с тренировками", "Посты о трансформации", "Запуски челленджей"],
      playbook: [
        "Опубликуйте рилс с результатом и просьбой оставить одно ключевое слово.",
        "Делайте DM коротким и сфокусированным на обещанном материале.",
        "Добавьте ссылку на анкету коучинга после бесплатной ценности.",
        "Просматривайте журналы ошибок и пропусков после популярных рилсов.",
      ],
      metrics: ["Запросы гида", "Регистрации на челлендж", "Запросы на коучинг"],
    },
    "course-webinar": {
      title: "Приглашение на вебинар курса",
      category: "Образование",
      audience: "Продавцы курсов",
      summary:
        "Отправляйте ссылки на регистрацию вебинара или урок подписчикам, комментирующим WEBINAR, CLASS или LEARN на образовательных постах.",
      goal: "Лист ожидания запуска",
      outcome: "Превращайте образовательный охват в регистрации на вебинар и лист ожидания.",
      bestFor: ["Запуски курсов", "Мини-тренинги", "Живые воркшопы"],
      playbook: [
        "Привяжите кампанию к образовательному рилсу с доказательствами результата.",
        "Используйте одно основное ключевое слово в подписи и два запасных.",
        "Отправляйте ссылку на регистрацию с датой или обещанием.",
        "Сравнивайте органические посты по журналу отправок до затрат на рекламу.",
      ],
      metrics: ["Регистрации", "Отправки DM", "Явка на вебинар"],
    },
    "beauty-price-list": {
      title: "Прайс-лист услуг красоты",
      category: "Локальные услуги",
      audience: "Салоны, спа и бьюти-мастера",
      summary:
        "Отвечайте ценами, ссылками на запись и меню услуг, когда пишут PRICE, MENU или BOOK.",
      goal: "Ответ о цене или доступности",
      outcome: "Меньше повторяющихся ответов в комментариях, больше записей на услуги.",
      bestFor: ["Рилсы «до/после»", "Посты с меню услуг", "Посты о доступности"],
      playbook: [
        "Выберите пост, где уже спрашивают о ценах.",
        "Добавьте ссылку на запись с чёткими категориями услуг.",
        "Держите DM в рамках правил, избегая медицинских или преувеличенных заявлений.",
        "Обновляйте ссылку при изменении цен или доступности.",
      ],
      metrics: ["Клики по ссылке записи", "Отправки DM", "Новые записи"],
    },
    "restaurant-menu": {
      title: "Меню и бронирование ресторана",
      category: "Гостеприимство",
      audience: "Рестораны и кафе",
      summary:
        "Отправляйте меню, ссылки на бронирование или спецпредложения, когда гости пишут MENU, TABLE или RESERVE.",
      goal: "Запрос ссылки на товар",
      outcome: "Превращайте рилсы о еде в бронирования и просмотры меню.",
      bestFor: ["Спецпредложения", "Запуски нового меню", "Продвижение бронирований на выходные"],
      playbook: [
        "Используйте аппетитный рилс о еде с чётким призывом к комментарию.",
        "Отправляйте удобное для мобильных меню или страницу бронирования.",
        "Упоминайте ограниченность мест только когда это правда.",
        "Повторяйте шаблон для сезонных предложений.",
      ],
      metrics: ["Клики по меню", "Бронирования", "Ответы по кампании на выходные"],
    },
    "event-rsvp": {
      title: "Кампания RSVP для мероприятия",
      category: "Мероприятия",
      audience: "Площадки, сообщества и команды запусков",
      summary:
        "Отправляйте формы RSVP, ссылки на календарь или билеты, когда кто-то пишет RSVP, TICKET или JOIN.",
      goal: "Лист ожидания запуска",
      outcome: "Превращайте внимание к событию в измеримые RSVP.",
      bestFor: ["Поп-апы", "Воркшопы", "Мероприятия сообщества"],
      playbook: [
        "Выберите анонс события или рилс-рекап.",
        "Используйте RSVP как основное ключевое слово и добавьте запасные, связанные с билетами.",
        "Отправляйте одну ссылку с датой, местом и подтверждением.",
        "Приостанавливайте кампанию после окончания события.",
      ],
      metrics: ["RSVP", "Клики по билетам", "Ответы по посту о событии"],
    },
    "creator-media-kit": {
      title: "Медиакит для брендов",
      category: "Бизнес автора",
      audience: "Авторы и агентства",
      summary:
        "Отправляйте медиакит, прайс-карту или форму запроса от бренда, когда бренды пишут COLLAB, KIT или RATES.",
      goal: "Клиентская кампания агентства",
      outcome: "Захватывайте интерес брендов, не прося искать информацию в шапке профиля.",
      bestFor: ["Закреплённые портфолио-рилсы", "Кейс-посты", "Обращения брендов"],
      playbook: [
        "Закрепите пост о коллаборации или портфолио-рилс.",
        "Используйте профессиональные ключевые слова, которые бренды пишут естественно.",
        "Отправляйте ссылку на медиакит и один уточняющий вопрос.",
        "Проверяйте DM еженедельно и отмечайте квалифицированные возможности.",
      ],
      metrics: ["Запросы от брендов", "Клики по медиакиту", "Квалифицированные DM о партнёрстве"],
    },
  },
  uz: {
    "dtc-product-link": {
      title: "DTC mahsulot havolasini tarqatish",
      category: "Ijtimoiy savdo",
      audience: "DTC brendlari",
      summary:
        "LINK yoki SHOP kabi izohlarni aniq mahsulot sahifasi, o'lcham qo'llanmasi yoki ishga tushirish to'plami bilan shaxsiy javobga aylantiring.",
      goal: "Mahsulot havolasi so'rovi",
      outcome: "Yuqori qiziqishli izohlardan ko'proq iliq mahsulot suhbatlari.",
      bestFor: ["Mahsulot chiqarishlari", "UGC rilslar", "Influencer kampaniyalari"],
      playbook: [
        "Mahsulotni aniq ko'rsatadigan rils yoki postni tanlang.",
        "Birinchi kalit so'zlar sifatida LINK, SHOP va BUY'dan foydalaning.",
        "Bitta qisqa foyda gapi bilan to'g'ridan-to'g'ri mahsulot URL'ini yuboring.",
        "Qaysi mahsulot postlari eng ko'p yuborilgan javob keltirishini kuzating.",
      ],
      metrics: ["Yuborilgan javoblar", "O'tkazib yuborilgan takrorlar", "Mahsulot havolasi CTR"],
    },
    "real-estate-lead-form": {
      title: "Ko'chmas mulk lid formasi",
      category: "Lid generatsiyasi",
      audience: "Agentlar va broker jamoalari",
      summary:
        "E'lon rilsiga izoh qoldirgach, xaridor yoki sotuvchilarga baholash formasi, ko'rish uchun bron havolasi yoki mahalla qo'llanmasini yuboring.",
      goal: "Lid-magnit yetkazib berish",
      outcome: "E'longa qiziqishni izohlar orasida yo'qolib ketishidan oldin ushlab qoling.",
      bestFor: ["E'lon rilslari", "Mahalla qo'llanmalari", "Sotuvchi baholash postlari"],
      playbook: [
        "Bitta mulk yoki mahalliy bozor postini tanlang.",
        "Umumiy emoji emas, xaridor niyatiga mos kalit so'zlardan foydalaning.",
        "Aloqa ma'lumotlari va vaqtni so'raydigan forma yuboring.",
        "Formadan kelgan malakali lidlarni qo'lda kuzatib boring.",
      ],
      metrics: ["Lid formasi ochilishlari", "DM yuborishlar", "Bron qilingan ko'rishlar"],
    },
    "fitness-plan": {
      title: "Fitnes reja yuklab olish",
      category: "Kontent-meyker voronkalari",
      audience: "Murabbiylar va fitnes kontent-meykerlar",
      summary:
        "Obunachilar PLAN, FIT yoki START deb izoh qoldirganda mashq rejasi, KBJU qo'llanmasi yoki koching so'rovnomasini yetkazib bering.",
      goal: "Lid-magnit yetkazib berish",
      outcome: "Motivatsiyalangan obunachilarni koching yoki email voronkasiga o'tkazing.",
      bestFor: ["Mashq rilslari", "Transformatsiya postlari", "Challenge ishga tushirishlari"],
      playbook: [
        "Natijani ko'rsatadigan va bitta kalit so'z so'raydigan rils joylang.",
        "DM'ni qisqa va va'da qilingan materialga qaratilgan holda saqlang.",
        "Bepul qiymatdan keyin koching so'rovnomasi havolasini qo'shing.",
        "Ko'p tashrif buyurgan rilslardan keyin muvaffaqiyatsiz va o'tkazib yuborilgan jurnallarni ko'rib chiqing.",
      ],
      metrics: ["Qo'llanma so'rovlari", "Challenge ro'yxatga olishlari", "Koching so'rovlari"],
    },
    "course-webinar": {
      title: "Kurs vebinariga taklif",
      category: "Ta'lim",
      audience: "Kurs sotuvchilar",
      summary:
        "Ta'limiy postlarda WEBINAR, CLASS yoki LEARN deb izoh qoldirgan obunachilarga vebinarga ro'yxatdan o'tish yoki dars havolalarini yuboring.",
      goal: "Ishga tushirish kutish ro'yxati",
      outcome: "Ta'limiy qamrovni vebinar va kutish ro'yxatiga ro'yxatdan o'tishlarga aylantiring.",
      bestFor: ["Kurs ishga tushirishlari", "Mini treninglar", "Jonli seminarlar"],
      playbook: [
        "Kampaniyani dalillarga boy ta'limiy rilsga bog'lang.",
        "Sarlavhada bitta asosiy kalit so'z va ikkita zaxira so'z ishlating.",
        "Ro'yxatdan o'tish havolasini sana yoki va'da bilan yuboring.",
        "Reklama xarajatidan oldin organik postlarni yuborilgan jurnal bo'yicha solishtiring.",
      ],
      metrics: ["Ro'yxatdan o'tishlar", "DM yuborishlar", "Kelish darajasi"],
    },
    "beauty-price-list": {
      title: "Go'zallik xizmatlari narxlar ro'yxati",
      category: "Mahalliy xizmatlar",
      audience: "Salonlar, spa va go'zallik ustalari",
      summary:
        "Odamlar PRICE, MENU yoki BOOK deb izoh qoldirganda narx, bron havolalari va xizmat menyusi bilan javob bering.",
      goal: "Narx yoki bo'sh vaqt haqida javob",
      outcome: "Takrorlanuvchi izoh javoblarini kamaytiring va xaridorlarni bronga yo'naltiring.",
      bestFor: ["Oldin/keyin rilslari", "Xizmat menyusi postlari", "Bo'sh vaqt postlari"],
      playbook: [
        "Odamlar allaqachon narx so'rayotgan postni tanlang.",
        "Aniq xizmat toifalari bilan bron havolasini qo'shing.",
        "DM'ni qoidalarga mos saqlang, tibbiy yoki bo'rttirilgan da'volardan saqlaning.",
        "Narx yoki bo'sh vaqt o'zgarganda havolani yangilang.",
      ],
      metrics: ["Bron havolasi bosishlari", "DM yuborishlar", "Yangi uchrashuvlar"],
    },
    "restaurant-menu": {
      title: "Restoran menyusi va bron qilish",
      category: "Mehmondo'stlik",
      audience: "Restoranlar va kafelar",
      summary:
        "Mehmonlar MENU, TABLE yoki RESERVE deb izoh qoldirganda menyu, bron havolalari yoki tadbir takliflarini yuboring.",
      goal: "Mahsulot havolasi so'rovi",
      outcome: "Ovqat rilslarini bron qilish va menyu ko'rishlariga aylantiring.",
      bestFor: ["Maxsus takliflar", "Yangi menyu ishga tushirishlari", "Dam olish kunlari uchun bron targ'iboti"],
      playbook: [
        "Aniq izoh chaqirig'i bilan ishtahani ochadigan ovqat rilsidan foydalaning.",
        "Mobilga qulay menyu yoki bron sahifasini yuboring.",
        "Cheklangan o'rindiqlarni faqat rost bo'lgandagina eslating.",
        "Mavsumiy takliflar uchun shablonni takrorlang.",
      ],
      metrics: ["Menyu bosishlari", "Bronlar", "Dam olish kuni kampaniya javoblari"],
    },
    "event-rsvp": {
      title: "Tadbir uchun RSVP kampaniyasi",
      category: "Tadbirlar",
      audience: "Maydonlar, jamoalar va ishga tushirish jamoalari",
      summary:
        "Kimdir RSVP, TICKET yoki JOIN deb izoh qoldirgach, RSVP formalari, taqvim havolalari yoki chipta sahifalarini yuboring.",
      goal: "Ishga tushirish kutish ro'yxati",
      outcome: "Tadbirga qiziqishni o'lchanadigan RSVP'larga aylantiring.",
      bestFor: ["Pop-up tadbirlar", "Seminarlar", "Jamoa tadbirlari"],
      playbook: [
        "Tadbir e'loni yoki xulosa rilsini tanlang.",
        "Asosiy kalit so'z sifatida RSVP'dan foydalaning va chiptaga oid zaxira so'zlar qo'shing.",
        "Sana, joy va tasdiqni o'z ichiga olgan bitta havola yuboring.",
        "Tadbir tugagach kampaniyani to'xtating.",
      ],
      metrics: ["RSVP'lar", "Chipta bosishlari", "Tadbir posti bo'yicha javoblar"],
    },
    "creator-media-kit": {
      title: "Kontent-meyker media-kit javobi",
      category: "Kontent-meyker biznesi",
      audience: "Kontent-meykerlar va agentliklar",
      summary:
        "Brendlar COLLAB, KIT yoki RATES deb izoh qoldirganda media-kit, narx kartasi yoki brend so'rovi formasini yuboring.",
      goal: "Agentlik mijoz kampaniyasi",
      outcome: "Odamlarni bio'dan qidirishga majburlamasdan brend qiziqishini ushlab qoling.",
      bestFor: ["Mahkamlangan portfolio rilslari", "Keys-postlar", "Brendlarga murojaat"],
      playbook: [
        "Hamkorlik posti yoki kontent-meyker portfolio rilsini mahkamlang.",
        "Brendlar tabiiy ravishda yozadigan professional kalit so'zlardan foydalaning.",
        "Media-kit havolasi va bitta malaka savolini yuboring.",
        "DM'larni har hafta tekshiring va malakali imkoniyatlarni belgilang.",
      ],
      metrics: ["Brend so'rovlari", "Media-kit bosishlari", "Malakali hamkorlik DM'lari"],
    },
  },
};

export function getCampaignTemplates(locale: Locale): CampaignTemplate[] {
  const content = TEMPLATE_CONTENT[locale];
  return TEMPLATE_BASE.map((base) => ({ ...base, ...content[base.slug] }));
}

export function getCampaignTemplate(
  slug: string | null | undefined,
  locale: Locale
): CampaignTemplate | null {
  if (!slug) return null;
  return getCampaignTemplates(locale).find((template) => template.slug === slug) ?? null;
}

export function getCampaignTemplateSlugs() {
  return TEMPLATE_BASE.map((template) => template.slug);
}
