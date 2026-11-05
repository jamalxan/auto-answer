# Ko'p tarmoqli kontent reja (`/content`) — dizayn

Sana: 2026-10-29. Muallif so'rovi: "rejalashtirishda har bir social media uchun alohida ham, hammasiga birga ham joylash imkoni bo'lsin; Instagram uchun bor narsa (bir nechta akkaunt, boshqarish, statistika, avto-xabarlar) Facebook, Threads, YouTube uchun ham bo'lsin; dizayni chiroyli va moslashgan".

## Maqsad
Foydalanuvchi bitta joyda (`/content`) har bir tarmoq (Instagram, Facebook, Threads, YouTube) bo'yicha alohida, yoki hammasini birga ko'rib, rejalashtirib, statistikasini ko'rib va avto-javoblarini sozlay oladi. Bir tarmoqda bir nechta akkaunt bo'lishi mumkin.

## Hozirgi holat (kodda tekshirilgan)
- `ScheduledPost.instagramAccountId` majburiy; boshqa tarmoqlar `ChannelPostTarget` (cross-post) orqali qo'shimcha chiqadi. Faqat Facebook/Threads/YouTube'ga post qo'yib bo'lmaydi.
- Ko'p akkaunt: `ChannelCredential` allaqachon `(workspace, channel, externalAccountId)` bo'yicha unikal, ya'ni bir nechta bo'la oladi; UI `/channels` da.
- Statistika (`ContentPostStat`, `content-intel`) faqat Instagram.
- Avto-javoblar: `ChannelAutoReply` + `/channels` ichidagi tab, Facebook/Threads/YouTube uchun bor.
- Chiqarish: IG uchun `lib/content/publish.ts` (navbat, quota, slot Instagram akkauntga bog'liq); targetlar uchun `lib/channels/crosspost.ts` sweep.

## Qarorlar (foydalanuvchi tanlagan)
1. **Joylashuv: "A" varianti** — bitta `/content` sahifa, tepada tarmoq tanlagichi: Hammasi · Instagram · Facebook · Threads · YouTube (har birida akkaunt soni). Ostida bo'limlar: Reja, Kalendar, Statistika, Akkauntlar, Avto-javoblar, Kutubxona, Shablonlar, Import, Tasdiqlar. Tanlangan tarmoq reja, kalendar, statistika, avto-javoblarni filtrlaydi.
2. **Yangi post: ikki rejim** — "Hammasiga birga" (bitta matn/media/vaqt, tarmoq va akkauntlar belgilanadi) va "Har biriga alohida" (har tarmoq/akkaunt uchun o'z matni va vaqti).
3. Bir tarmoqda bir nechta akkaunt, hammasi uchun boshqarish, statistika, avto-javob.

## Mening qarorlarim (tekshirib ko'ring)
- **Faqat-Instagramsiz post:** `ScheduledPost.instagramAccountId` ixtiyoriy (nullable) bo'ladi. Null bo'lsa IG chiqarish bosqichi o'tkazib yuboriladi, post holati targetlar bo'yicha hisoblanadi. IG-ga bog'liq narsalar (quota, slot, first comment, kampaniya ulash) faqat id mavjud bo'lsa ishlaydi.
- **"Alohida" rejim** ichkarida: har tarmoq/akkaunt uchun `ChannelPostTarget` ga o'z `caption` va `scheduledAt` override maydonlari qo'shiladi (null = postnikini ishlat).
- **Statistika:** `ChannelPostStat` jadvali (kanal, akkaunt, tashqi id, ko'rishlar, layk, komment, ulashish) + har tarmoq adapteri `fetchInsights`. Instagram statistikasi o'zgarmaydi.
- **Avto-javoblar:** yangi tab emas, `/content` ichida "Avto-javoblar" bo'limi; Instagram uchun mavjud kampaniyalar, boshqalar uchun `ChannelAutoReply` ko'rinadi (bitta ro'yxat, tarmoq filtri bilan). Mavjud `/channels` sahifasi qoladi.
- **Dizayn:** mavjud brend primitivlari (`chip`, `panel`, `PageHeader`) ishlatiladi, har tarmoqqa o'z rangli belgi (`ChannelMark`).

## Bosqichlar (har biri alohida PR/deploy)
1. Poydevor: nullable IG, tarmoq tanlagichi, kompozer rejimlari (birga/alohida), reja va kalendarda tarmoq filtri.
2. Akkauntlar: `/content` ichida "Akkauntlar" bo'limi (ulash, uzish, holat, nom), bir nechta akkaunt.
3. Statistika: `ChannelPostStat` + adapterlar + "Statistika" bo'limi.
4. Avto-javoblar bo'limi birlashtirilgan ko'rinishda.
5. Dizayn jilosi va mobil.

## Maqsad emas
Yangi tarmoq qo'shish (TikTok, LinkedIn), reklama (`/ads`), Telegram'ni yangi bo'limga ko'chirish.

## Xavf
`instagramAccountId` nullable qilinishi 100+ joyga ta'sir qiladi; TypeScript xatolari ro'yxati yo'l xaritasi bo'ladi. Har bosqichdan keyin `__tests__/content-*` va `channels-*` testlari yashil bo'lishi shart.
